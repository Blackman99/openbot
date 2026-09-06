import { afterEach, expect, it } from 'vitest';
import { publicTaskFixture } from '../helpers/public-task-fixture.js';
import { RoutineService } from '../../src/routines/service.js';
import { buildApp } from '../../src/app.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function routineFixture() {
  const f = await publicTaskFixture(cleanup);
  const routines = new RoutineService(f.pool, () => new Date('2026-09-06T12:00:00.000Z'));
  const publicApp = buildApp({
    auth: f.auth,
    apiTokens: f.tokens,
    groups: f.groups,
    groupBots: f.groupBots,
    groupRouting: f.groupRouting,
    conversations: f.conversations,
    tasks: f.tasks,
    workspaceEvents: f.workspaceEvents,
    routines,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => publicApp.close());
  return { ...f, routines, publicApp };
}

it('stores owner, group, prompt, lead policy, IANA zone, execution time, budget, and expiration', async () => {
  const f = await routineFixture();
  const headers = await f.bearer(['groups:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/routines',
    headers,
    payload: {
      groupId,
      prompt: 'Prepare the Monday collaboration brief.',
      leadGrantId,
      timeZone: 'Asia/Shanghai',
      executeAt: '2026-09-07T01:00:00.000Z',
      expiresAt: '2026-09-10T01:00:00.000Z',
      maxCostMicros: 2_500_000,
    },
  });
  expect(created.statusCode).toBe(201);
  expect(created.headers['cache-control']).toBe('private, no-store');
  expect(created.headers['x-content-type-options']).toBe('nosniff');
  const routine = created.json().routine;
  expect(routine).toMatchObject({
    id: expect.any(String),
    groupId,
    ownerUserId: f.owner.user.id,
    prompt: 'Prepare the Monday collaboration brief.',
    routingPolicy: 'lead',
    leadGrantId,
    timeZone: 'Asia/Shanghai',
    maxCostMicros: 2_500_000,
    kind: 'one_time',
    status: 'active',
  });
  expect(new Date(routine.executeAt).toISOString()).toBe('2026-09-07T01:00:00.000Z');
  expect(new Date(routine.expiresAt).toISOString()).toBe('2026-09-10T01:00:00.000Z');
  const row = (
    await f.pool.query(
      `SELECT owner_user_id,group_id,prompt,lead_grant_id,routing_policy,time_zone,
              execute_at,expires_at,max_cost_micros,kind,status
       FROM routines WHERE id=$1`,
      [routine.id],
    )
  ).rows[0];
  expect(row).toMatchObject({
    owner_user_id: f.owner.user.id,
    group_id: groupId,
    prompt: 'Prepare the Monday collaboration brief.',
    lead_grant_id: leadGrantId,
    routing_policy: 'lead',
    time_zone: 'Asia/Shanghai',
    kind: 'one_time',
    status: 'active',
  });
  expect(Number(row.max_cost_micros)).toBe(2_500_000);
});

it('stores group routing policy when leadGrantId is omitted', async () => {
  const f = await routineFixture();
  const headers = await f.bearer(['groups:write']);
  const { groupId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/routines',
    headers,
    payload: {
      groupId,
      prompt: 'Use the group default lead at trigger time.',
      timeZone: 'UTC',
      executeAt: '2026-09-07T02:00:00.000Z',
      expiresAt: '2026-09-08T02:00:00.000Z',
      maxCostMicros: 500_000,
    },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().routine).toMatchObject({
    groupId,
    routingPolicy: 'group',
    leadGrantId: null,
    timeZone: 'UTC',
    maxCostMicros: 500_000,
  });
});

it('rejects create without groups:write and rejects URL-like query credentials', async () => {
  const f = await routineFixture();
  const { groupId, leadGrantId } = await f.readyGroup();
  const payload = {
    groupId,
    prompt: 'Denied without scope.',
    leadGrantId,
    timeZone: 'UTC',
    executeAt: '2026-09-07T03:00:00.000Z',
    expiresAt: '2026-09-08T03:00:00.000Z',
    maxCostMicros: 1000,
  };
  const readOnly = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/routines',
    headers: await f.bearer(['groups:read']),
    payload,
  });
  expect(readOnly.statusCode).toBe(403);
  expect(readOnly.json().error.code).toBe('insufficient_scope');
});

async function createActiveRoutine(
  f: Awaited<ReturnType<typeof routineFixture>>,
  overrides: Record<string, unknown> = {},
) {
  const headers = await f.bearer(['groups:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/routines',
    headers,
    payload: {
      groupId,
      prompt: 'Original one-time routine.',
      leadGrantId,
      timeZone: 'Asia/Shanghai',
      executeAt: '2026-09-07T01:00:00.000Z',
      expiresAt: '2026-09-10T01:00:00.000Z',
      maxCostMicros: 2_500_000,
      ...overrides,
    },
  });
  expect(created.statusCode).toBe(201);
  return { headers, groupId, leadGrantId, routine: created.json().routine };
}

it('edits mutable schedule fields while preserving owner and group', async () => {
  const f = await routineFixture();
  const { headers, groupId, routine } = await createActiveRoutine(f);
  const edited = await f.publicApp.inject({
    method: 'PATCH',
    url: `/v1/routines/${routine.id}`,
    headers,
    payload: {
      prompt: 'Edited collaboration brief.',
      timeZone: 'UTC',
      executeAt: '2026-09-07T05:00:00.000Z',
      expiresAt: '2026-09-09T05:00:00.000Z',
      maxCostMicros: 1_250_000,
      leadGrantId: null,
    },
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.headers['cache-control']).toBe('private, no-store');
  expect(edited.json().routine).toMatchObject({
    id: routine.id,
    groupId,
    ownerUserId: f.owner.user.id,
    prompt: 'Edited collaboration brief.',
    routingPolicy: 'group',
    leadGrantId: null,
    timeZone: 'UTC',
    maxCostMicros: 1_250_000,
    status: 'active',
  });
  expect(new Date(edited.json().routine.executeAt).toISOString()).toBe('2026-09-07T05:00:00.000Z');
  expect(new Date(edited.json().routine.expiresAt).toISOString()).toBe('2026-09-09T05:00:00.000Z');
});

it('pauses, resumes, and cancels one-time routines through public lifecycle routes', async () => {
  const f = await routineFixture();
  const { headers, routine } = await createActiveRoutine(f);

  const paused = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/routines/${routine.id}/pause`,
    headers,
  });
  expect(paused.statusCode).toBe(200);
  expect(paused.json().routine).toMatchObject({ id: routine.id, status: 'paused' });

  const resumed = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/routines/${routine.id}/resume`,
    headers,
  });
  expect(resumed.statusCode).toBe(200);
  expect(resumed.json().routine).toMatchObject({ id: routine.id, status: 'active' });

  const cancelled = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/routines/${routine.id}/cancel`,
    headers,
  });
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json().routine).toMatchObject({ id: routine.id, status: 'cancelled' });

  const audits = await f.pool.query<{ event_type: string }>(
    `SELECT event_type FROM audit_events
     WHERE metadata->>'routineId'=$1`,
    [routine.id],
  );
  expect(audits.rows.map((row) => row.event_type).sort()).toEqual([
    'routine.cancelled',
    'routine.created',
    'routine.paused',
    'routine.resumed',
  ]);
});

it('rejects invalid lifecycle transitions and missing groups:write on mutations', async () => {
  const f = await routineFixture();
  const { headers, routine } = await createActiveRoutine(f);

  const resumeActive = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/routines/${routine.id}/resume`,
    headers,
  });
  expect(resumeActive.statusCode).toBe(409);
  expect(resumeActive.json().error.code).toBe('routine_not_paused');

  await f.publicApp.inject({
    method: 'POST',
    url: `/v1/routines/${routine.id}/cancel`,
    headers,
  });
  const editCancelled = await f.publicApp.inject({
    method: 'PATCH',
    url: `/v1/routines/${routine.id}`,
    headers,
    payload: { prompt: 'Too late.' },
  });
  expect(editCancelled.statusCode).toBe(409);
  expect(editCancelled.json().error.code).toBe('routine_not_mutable');

  const pauseCancelled = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/routines/${routine.id}/pause`,
    headers,
  });
  expect(pauseCancelled.statusCode).toBe(409);
  expect(pauseCancelled.json().error.code).toBe('routine_not_active');

  const readOnly = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/routines/${routine.id}/pause`,
    headers: await f.bearer(['groups:read']),
  });
  expect(readOnly.statusCode).toBe(403);
  expect(readOnly.json().error.code).toBe('insufficient_scope');
});

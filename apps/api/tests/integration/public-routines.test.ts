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

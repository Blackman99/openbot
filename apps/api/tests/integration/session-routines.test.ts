import { afterEach, expect, it } from 'vitest';
import { publicTaskFixture } from '../helpers/public-task-fixture.js';
import { RoutineService } from '../../src/routines/service.js';
import { buildApp } from '../../src/app.js';
import { botRoutineCollaborationDenial } from '../../src/routines/bot-actions.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const f = await publicTaskFixture(cleanup);
  const routines = new RoutineService(f.pool, () => new Date('2026-09-06T12:00:00.000Z'));
  const app = buildApp({
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
    webOrigin: 'http://localhost:3000',
  });
  cleanup.push(() => app.close());
  return { ...f, routines, app };
}

it('creates, lists, edits, pauses, resumes, and cancels routines through the session UI API', async () => {
  const f = await fixture();
  const { groupId, leadGrantId } = await f.readyGroup();
  const cookie = f.headers.cookie;
  const origin = 'http://localhost:3000';
  const base = `/api/v1/workspaces/${f.owner.workspace.id}/groups/${groupId}/routines`;
  const created = await f.app.inject({
    method: 'POST',
    url: base,
    headers: { cookie, origin, 'content-type': 'application/json' },
    payload: {
      prompt: 'Session-created Monday brief.',
      leadGrantId,
      timeZone: 'Asia/Shanghai',
      executeAt: '2026-09-07T01:00:00.000Z',
      expiresAt: '2026-09-10T01:00:00.000Z',
      maxCostMicros: 2_000_000,
    },
  });
  expect(created.statusCode).toBe(201);
  const routineId = created.json().routine.id;
  const listed = await f.app.inject({ method: 'GET', url: base, headers: { cookie } });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().routines.map((row: { id: string }) => row.id)).toContain(routineId);
  const edited = await f.app.inject({
    method: 'PATCH',
    url: `${base}/${routineId}`,
    headers: { cookie, origin, 'content-type': 'application/json' },
    payload: { prompt: 'Updated session brief.', maxCostMicros: 2_500_000 },
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().routine.prompt).toBe('Updated session brief.');
  const paused = await f.app.inject({
    method: 'POST',
    url: `${base}/${routineId}/pause`,
    headers: { cookie, origin },
  });
  expect(paused.statusCode).toBe(200);
  expect(paused.json().routine.status).toBe('paused');
  const resumed = await f.app.inject({
    method: 'POST',
    url: `${base}/${routineId}/resume`,
    headers: { cookie, origin },
  });
  expect(resumed.statusCode).toBe(200);
  expect(resumed.json().routine.status).toBe('active');
  const cancelled = await f.app.inject({
    method: 'POST',
    url: `${base}/${routineId}/cancel`,
    headers: { cookie, origin },
  });
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json().routine.status).toBe('cancelled');
});

it('denies bot collaboration create and budget escalation without writing routines', async () => {
  const f = await fixture();
  const { groupId } = await f.readyGroup();
  expect(
    botRoutineCollaborationDenial({
      type: 'action',
      id: 'call-1',
      name: 'create_routine',
      arguments: {
        groupId,
        prompt: 'Bot-created schedule',
        timeZone: 'UTC',
        executeAt: '2026-09-07T01:00:00.000Z',
        expiresAt: '2026-09-08T01:00:00.000Z',
        maxCostMicros: 1_000_000,
      },
    }),
  ).toBe('create');
  const before = (
    await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM routines')
  ).rows[0]!.count;
  expect(before).toBe('0');
  expect(
    botRoutineCollaborationDenial({
      type: 'action',
      id: 'call-2',
      name: 'edit_routine',
      arguments: {
        routineId: '33333333-3333-4333-8333-333333333333',
        maxCostMicros: 9_000_000,
      },
    }),
  ).toBe('escalate');
});

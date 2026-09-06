import { afterEach, expect, it } from 'vitest';
import { publicTaskFixture } from '../helpers/public-task-fixture.js';
import { RoutineExecutor } from '../../src/routines/executor.js';
import { RoutineService } from '../../src/routines/service.js';
import { buildApp } from '../../src/app.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(now: Date) {
  const f = await publicTaskFixture(cleanup);
  const routines = new RoutineService(f.pool, () => now);
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
  return { ...f, routines, publicApp, now };
}

async function createDueRoutine(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  const headers = await f.bearer(['groups:write', 'groups:read']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/routines',
    headers,
    payload: {
      groupId,
      prompt: 'Prepare the scheduled collaboration brief.',
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

it('creates exactly one collaboration task at the scheduled time and links it', async () => {
  const createNow = new Date('2026-09-06T12:00:00.000Z');
  const f = await fixture(createNow);
  const { headers, routine } = await createDueRoutine(f);

  const triggerNow = new Date('2026-09-07T01:00:00.000Z');
  const executor = new RoutineExecutor(f.pool, () => triggerNow);
  const first = await executor.runOnce();
  expect(first).toMatchObject({
    handled: true,
    routineId: routine.id,
    outcome: 'created',
    taskId: expect.any(String),
    conversationId: expect.any(String),
  });

  const second = await executor.runOnce();
  expect(second).toEqual({ handled: false });

  const tasks = await f.pool.query<{ id: string; status: string; body: string | null }>(
    `SELECT t.id,t.status,e.body
     FROM routine_occurrences o
     JOIN tasks t ON t.id=o.task_id
     JOIN conversation_events e ON e.id=t.trigger_event_id
     WHERE o.routine_id=$1`,
    [routine.id],
  );
  expect(tasks.rows).toHaveLength(1);
  expect(tasks.rows[0]).toMatchObject({
    id: first.handled ? first.taskId : undefined,
    status: 'queued',
    body: 'Prepare the scheduled collaboration brief.',
  });

  const occurrences = await f.pool.query(
    'SELECT occurrence_key,outcome FROM routine_occurrences WHERE routine_id=$1',
    [routine.id],
  );
  expect(occurrences.rows).toEqual([
    { occurrence_key: '2026-09-07T01:00:00.000Z', outcome: 'created' },
  ]);

  const got = await f.publicApp.inject({
    method: 'GET',
    url: `/v1/routines/${routine.id}`,
    headers,
  });
  expect(got.statusCode).toBe(200);
  expect(got.json().routine).toMatchObject({
    id: routine.id,
    status: 'completed',
    taskId: first.handled ? first.taskId : null,
    conversationId: first.handled ? first.conversationId : null,
    maxCostMicros: 2_500_000,
  });

  const policy = (
    await f.pool.query<{ execution_policy: { maxCostMicros: number } }>(
      'SELECT execution_policy FROM tasks WHERE id=$1',
      [first.handled ? first.taskId : null],
    )
  ).rows[0];
  expect(policy?.execution_policy.maxCostMicros).toBe(2_500_000);
});

it('recovers one unexpired due routine after a simulated restart without duplication', async () => {
  const createNow = new Date('2026-09-06T12:00:00.000Z');
  const f = await fixture(createNow);
  const { routine } = await createDueRoutine(f, {
    executeAt: '2026-09-07T02:00:00.000Z',
    expiresAt: '2026-09-08T02:00:00.000Z',
  });

  // Restart lands after execute_at; the due poll recovers the occurrence once.
  const afterRestart = new Date('2026-09-07T02:05:00.000Z');
  const executor = new RoutineExecutor(f.pool, () => afterRestart);
  const recovered = await executor.runOnce();
  expect(recovered).toMatchObject({
    handled: true,
    routineId: routine.id,
    outcome: 'created',
    taskId: expect.any(String),
  });
  expect(await executor.runOnce()).toEqual({ handled: false });
  expect(await executor.executeDue(routine.id)).toEqual({ handled: false });

  const count = await f.pool.query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM tasks t JOIN routine_occurrences o ON o.task_id=t.id WHERE o.routine_id=$1',
    [routine.id],
  );
  expect(count.rows[0]?.n).toBe('1');
});

it('marks an overdue expired routine without creating a task', async () => {
  const createNow = new Date('2026-09-06T12:00:00.000Z');
  const f = await fixture(createNow);
  const { routine } = await createDueRoutine(f, {
    executeAt: '2026-09-07T01:00:00.000Z',
    expiresAt: '2026-09-07T02:00:00.000Z',
  });

  const afterExpiry = new Date('2026-09-07T02:00:00.000Z');
  const executor = new RoutineExecutor(f.pool, () => afterExpiry);
  const result = await executor.runOnce();
  expect(result).toMatchObject({
    handled: true,
    routineId: routine.id,
    outcome: 'expired',
  });
  expect('taskId' in result && result.taskId).toBeFalsy();

  const tasks = await f.pool.query(
    'SELECT 1 FROM routine_occurrences WHERE routine_id=$1 AND task_id IS NOT NULL',
    [routine.id],
  );
  expect(tasks.rows).toHaveLength(0);
  const status = (
    await f.pool.query<{ status: string }>('SELECT status FROM routines WHERE id=$1', [routine.id])
  ).rows[0];
  expect(status?.status).toBe('expired');
});

it('rejects a second occurrence insert for the same key via uniqueness', async () => {
  const createNow = new Date('2026-09-06T12:00:00.000Z');
  const f = await fixture(createNow);
  const { routine } = await createDueRoutine(f);
  const triggerNow = new Date('2026-09-07T01:00:00.000Z');
  const executor = new RoutineExecutor(f.pool, () => triggerNow);
  expect((await executor.runOnce()).handled).toBe(true);

  await expect(
    f.pool.query(
      `INSERT INTO routine_occurrences(
        id,routine_id,workspace_id,occurrence_key,task_id,conversation_id,outcome,created_at
      ) VALUES($1,$2,$3,$4,NULL,NULL,'created',$5)`,
      [
        '99999999-9999-4999-8999-999999999999',
        routine.id,
        f.owner.workspace.id,
        '2026-09-07T01:00:00.000Z',
        triggerNow,
      ],
    ),
  ).rejects.toMatchObject({ code: '23505' });
});

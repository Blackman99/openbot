import { afterEach, describe, expect, it } from 'vitest';
import { modelFailure } from '../../src/providers/failure-taxonomy.js';
import { TaskAccessError, TaskConflictError } from '../../src/tasks/errors.js';
import { taskFixture } from '../helpers/task-fixture.js';

describe('COL-12 soft warnings and hard waiting_budget', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function budgetTask(
    now: () => Date,
    policy: { maxDurationSeconds?: number; maxTurns?: number },
    retryPolicy?: { maxAttemptsPerModel: number; maxRunsPerChain: number },
  ) {
    const f = await taskFixture(cleanup, now, retryPolicy ? { retryPolicy } : {});
    await f
      .worker(async () => {
        throw new Error('retire the fixture Task');
      })
      .runOnce();
    await f.pool.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
      f.owner.workspace.id,
      JSON.stringify(policy),
    ]);
    const task = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'budget-task',
      body: 'Stay inside the snapshotted cap.',
    });
    return { f, task };
  }

  async function warnings(
    pool: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    },
    taskId: string,
  ) {
    return (
      await pool.query(
        `SELECT e.event_type,e.body,e.event_data,w.dimension
         FROM conversation_events e
         JOIN task_execution_limit_warnings w ON w.event_id=e.id
         WHERE w.task_id=$1 ORDER BY e.sequence`,
        [taskId],
      )
    ).rows;
  }

  it('appends one visible warning when a completed Task crosses the turn soft threshold', async () => {
    let current = new Date('2026-09-06T02:00:00.000Z');
    const { f, task } = await budgetTask(() => current, { maxTurns: 1 });
    expect(
      await f
        .worker(async () => ({
          events: [
            { type: 'text', text: 'One allowed turn.' },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }))
        .runOnce(),
    ).toBe(true);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id),
    ).toMatchObject({
      status: 'completed',
      runCount: 1,
    });
    expect(await warnings(f.pool, task.id)).toMatchObject([
      {
        event_type: 'task.limit.warning',
        dimension: 'turns',
        body: 'Turn usage reached the 1 turns workspace limit.',
        event_data: {
          taskId: task.id,
          dimension: 'turns',
          used: 1,
          limit: 1,
          source: 'workspace',
          soft: true,
          hard: true,
        },
      },
    ]);
    expect(
      (
        await f.pool.query(
          `SELECT d.event_type FROM conversation_delivery_events d
           JOIN conversation_events e ON e.id=d.ledger_event_id
           WHERE e.event_type='task.limit.warning'`,
        )
      ).rows,
    ).toEqual([{ event_type: 'conversation.invalidated' }]);
    expect(
      await warnings(f.pool, task.id).then(async () => {
        await f
          .worker(async () => ({
            events: [
              { type: 'text', text: 'Must not run again.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          }))
          .runOnce();
        return warnings(f.pool, task.id);
      }),
    ).toHaveLength(1);
  });

  it('aborts the provider stream at the snapshotted duration and holds waiting_budget', async () => {
    let current = new Date('2026-09-06T03:00:00.000Z');
    const { f, task } = await budgetTask(
      () => current,
      { maxDurationSeconds: 1 },
      { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
    );
    expect(
      await f
        .worker(async (_input, _signal, onEvent) => {
          await onEvent?.({ type: 'text', text: 'Partial draft.' });
          current = new Date(current.getTime() + 1_000);
          return {
            events: [{ type: 'text', text: 'Partial draft.' }],
            raw: '',
            error: modelFailure('provider_rate_limited'),
          };
        })
        .runOnce(),
    ).toBe(true);
    const held = await f.tasks.get(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      task.id,
    );
    expect(held).toMatchObject({
      status: 'waiting_budget',
      runCount: 1,
      runs: [{ status: 'failed', error: 'execution_timeout', output: null }],
    });
    const run = (
      await f.pool.query<{
        id: string;
        started_at: Date;
        deadline_at: Date;
      }>('SELECT id,started_at,deadline_at FROM task_runs WHERE task_id=$1', [task.id])
    ).rows[0]!;
    expect(run.deadline_at.getTime() - run.started_at.getTime()).toBe(1_000);
    expect(
      (
        await f.pool.query('SELECT body,end_byte FROM task_run_partial_outputs WHERE run_id=$1', [
          run.id,
        ])
      ).rows,
    ).toEqual([{ body: 'Partial draft.', end_byte: Buffer.byteLength('Partial draft.') }]);
    expect(
      (
        await f.pool.query(
          `SELECT event_type, metadata->>'error' AS error
           FROM audit_events
           WHERE metadata->>'taskId'=$1 AND event_type IN ('task.failed','task.waiting_budget')
           ORDER BY occurred_at, event_type`,
          [task.id],
        )
      ).rows,
    ).toEqual([
      { event_type: 'task.failed', error: 'execution_timeout' },
      { event_type: 'task.waiting_budget', error: null },
    ]);
    expect((await warnings(f.pool, task.id)).map((row) => row.dimension)).toEqual(['duration']);
    expect(
      (await f.pool.query('SELECT count(*)::int AS n FROM task_runs WHERE task_id=$1', [task.id]))
        .rows[0],
    ).toEqual({ n: 1 });
    expect(await f.worker(async () => ({ events: [], raw: '' })).runOnce()).toBe(false);
  });

  it('grants one selected cap idempotently, resumes waiting_budget, and leaves snapshot plus usage unchanged', async () => {
    let current = new Date('2026-09-06T03:00:00.000Z');
    const { f, task } = await budgetTask(
      () => current,
      { maxDurationSeconds: 1 },
      { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
    );
    expect(
      await f
        .worker(async (_input, _signal, onEvent) => {
          await onEvent?.({ type: 'text', text: 'Partial draft.' });
          current = new Date(current.getTime() + 1_000);
          return {
            events: [{ type: 'text', text: 'Partial draft.' }],
            raw: '',
            error: modelFailure('provider_rate_limited'),
          };
        })
        .runOnce(),
    ).toBe(true);
    const held = await f.tasks.get(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      task.id,
    );
    expect(held.status).toBe('waiting_budget');
    const snapshot = (
      await f.pool.query<{
        max_duration_ms: string | number;
        max_turns: number;
      }>('SELECT max_duration_ms,max_turns FROM task_execution_limit_snapshots WHERE task_id=$1', [
        task.id,
      ])
    ).rows[0]!;
    expect(Number(snapshot.max_duration_ms)).toBe(1_000);
    const firstRun = (
      await f.pool.query<{
        id: string;
        started_at: Date;
        finished_at: Date;
        status: string;
        error_code: string | null;
        input_tokens: number | null;
        output_tokens: number | null;
      }>(
        'SELECT id,started_at,finished_at,status,error_code,input_tokens,output_tokens FROM task_runs WHERE task_id=$1 ORDER BY attempt',
        [task.id],
      )
    ).rows[0]!;
    const member = await f.addUser('member');
    await expect(
      f.tasks.grantLimit(member.id, f.owner.workspace.id, f.conversation.id, task.id, {
        idempotencyKey: 'raise-duration',
        dimension: 'duration',
        limit: 5_000,
      }),
    ).rejects.toBeInstanceOf(TaskAccessError);
    await expect(
      f.tasks.grantLimit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id, {
        idempotencyKey: 'raise-duration',
        dimension: 'duration',
        limit: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'task_limit_grant_not_increased' });
    const granted = await f.tasks.grantLimit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      task.id,
      {
        idempotencyKey: 'raise-duration',
        dimension: 'duration',
        limit: 5_000,
      },
    );
    expect(granted.task).toMatchObject({
      id: task.id,
      status: 'queued',
      runCount: 2,
    });
    expect(granted.grant).toMatchObject({
      taskId: task.id,
      dimension: 'duration',
      previousLimit: 1_000,
      grantedLimit: 5_000,
      runId: expect.any(String),
      attempt: 2,
    });
    expect(granted.grant.runId).not.toBe(firstRun.id);
    const replay = await f.tasks.grantLimit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      task.id,
      {
        idempotencyKey: 'raise-duration',
        dimension: 'duration',
        limit: 5_000,
      },
    );
    expect(replay.grant).toEqual(granted.grant);
    await expect(
      f.tasks.grantLimit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id, {
        idempotencyKey: 'raise-duration',
        dimension: 'duration',
        limit: 6_000,
      }),
    ).rejects.toBeInstanceOf(TaskConflictError);
    expect(
      (
        await f.pool.query(
          'SELECT max_duration_ms,max_turns FROM task_execution_limit_snapshots WHERE task_id=$1',
          [task.id],
        )
      ).rows[0],
    ).toEqual(snapshot);
    expect(
      (
        await f.pool.query<{
          id: string;
          started_at: Date;
          finished_at: Date;
          status: string;
          error_code: string | null;
          input_tokens: number | null;
          output_tokens: number | null;
        }>(
          'SELECT id,started_at,finished_at,status,error_code,input_tokens,output_tokens FROM task_runs WHERE id=$1',
          [firstRun.id],
        )
      ).rows[0],
    ).toEqual(firstRun);
    const queuedAudit = (
      await f.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1",
        [granted.grant.runId],
      )
    ).rows[0]!.metadata;
    expect(queuedAudit).toMatchObject({
      origin: 'budget_grant',
      sourceRunId: firstRun.id,
    });
    expect(
      await f
        .worker(async () => ({
          events: [
            { type: 'text', text: 'Resumed after the grant.' },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }))
        .runOnce(),
    ).toBe(true);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id),
    ).toMatchObject({
      status: 'completed',
      runCount: 2,
      runs: [{ id: granted.grant.runId, status: 'completed', error: null }],
    });
    expect(
      (
        await f.pool.query<{ id: string; status: string; error_code: string | null }>(
          'SELECT id,status,error_code FROM task_runs WHERE task_id=$1 ORDER BY attempt',
          [task.id],
        )
      ).rows,
    ).toEqual([
      { id: firstRun.id, status: 'failed', error_code: firstRun.error_code },
      { id: granted.grant.runId, status: 'completed', error_code: null },
    ]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { modelFailure } from '../../src/providers/failure-taxonomy.js';
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

  it('holds a Task at waiting_budget and starts no further Run after a hard duration limit', async () => {
    let current = new Date('2026-09-06T03:00:00.000Z');
    const { f, task } = await budgetTask(
      () => current,
      { maxDurationSeconds: 1 },
      { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
    );
    expect(
      await f
        .worker(async () => {
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
      runs: [{ status: 'failed', error: 'provider_failed' }],
    });
    expect((await warnings(f.pool, task.id)).map((row) => row.dimension)).toEqual(['duration']);
    expect(
      (await f.pool.query('SELECT count(*)::int AS n FROM task_runs WHERE task_id=$1', [task.id]))
        .rows[0],
    ).toEqual({ n: 1 });
    expect(await f.worker(async () => ({ events: [], raw: '' })).runOnce()).toBe(false);
  });
});

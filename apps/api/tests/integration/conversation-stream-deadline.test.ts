import { afterEach, describe, expect, it } from 'vitest';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import { taskFixture } from '../helpers/task-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('publication deadline sampled after mandatory writes', () => {
  it.each(['delta', 'final'] as const)(
    'rolls back late %s content before committing a terminal result',
    async (kind) => {
      let now = new Date();
      const f = await taskFixture(cleanup, () => now);
      const claim = (await new TaskQueue(f.pool, () => now).claimNext()).claim!;
      const before = (
        await f.pool.query('SELECT last_sequence FROM conversations WHERE id=$1', [
          f.conversation.id,
        ])
      ).rows[0].last_sequence;
      let waited = false;
      const transactions: string[] = [];
      // pg-mem has no transaction rollback. Snapshot restoration checks the
      // application's rollback branch only; the separate native barrier suite
      // must prove PostgreSQL lock waiting and atomic rollback.
      const pool: SqlPool = {
        connect: async () => {
          const connection = await f.pool.connect();
          const backup = f.database.backup();
          return {
            query: async (statement, parameters) => {
              if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) transactions.push(statement);
              const result = await connection.query(statement, parameters);
              if (statement === 'ROLLBACK') backup.restore();
              const boundary =
                kind === 'delta'
                  ? statement.startsWith('UPDATE task_run_streams SET delivered_bytes')
                  : statement.startsWith('INSERT INTO audit_events') &&
                    parameters?.[1] === 'task.completed';
              if (!waited && boundary) {
                waited = true;
                now = new Date(claim.deadlineAt.getTime() + 1);
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };
      const queue = new TaskQueue(pool, () => now);
      if (kind === 'delta') {
        await expect(queue.publishDelta(claim, 'Late draft.')).rejects.toMatchObject({
          code: 'execution_timeout',
        });
        expect(transactions).toEqual(['BEGIN', 'ROLLBACK']);
        expect(
          (
            await f.pool.query('SELECT last_sequence FROM conversations WHERE id=$1', [
              f.conversation.id,
            ])
          ).rows[0].last_sequence,
        ).toBe(before);
        expect(
          (await f.pool.query('SELECT * FROM task_run_streams WHERE run_id=$1', [claim.runId]))
            .rows,
        ).toHaveLength(0);
      } else {
        expect(await queue.finish(claim, { body: 'Late final.', usage: null })).toBe(true);
        expect(transactions).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
        expect(await f.read()).toMatchObject({
          status: 'failed',
          runs: [{ status: 'failed', error: 'execution_timeout', output: null }],
        });
        expect(
          (
            await f.pool.query('SELECT id FROM conversation_events WHERE bot_run_id=$1', [
              claim.runId,
            ])
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await f.pool.query(
              "SELECT id FROM audit_events WHERE event_type IN ('task.completed','conversation.bot_message_created')",
            )
          ).rows,
        ).toHaveLength(0);
      }
      expect(waited).toBe(true);
      const deliveries = (
        await f.pool.query(
          'SELECT event_type,run_status,delta_text FROM conversation_delivery_events WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence',
          [f.conversation.id, before],
        )
      ).rows;
      expect(deliveries).toEqual(
        kind === 'delta'
          ? []
          : [{ event_type: 'task.run.updated', run_status: 'failed', delta_text: null }],
      );
    },
  );
});

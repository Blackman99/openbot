import { afterEach, describe, expect, it } from 'vitest';
import { TaskQueue } from '../../src/tasks/queue.js';
import { CLAIM_LEASE_MS } from '../../src/tasks/lease.js';
import { taskFixture } from '../helpers/task-fixture.js';

type TaskRunRow = {
  id: string;
  attempt: number;
  status: string;
  error_code: string | null;
  claim_token: string | null;
  protocol: string | null;
  model_id: string | null;
};

async function taskRuns(
  pool: {
    query: (statement: string, parameters?: unknown[]) => Promise<{ rows: TaskRunRow[] }>;
  },
  taskId: string,
) {
  return (
    await pool.query(
      'SELECT id,attempt,status,error_code,claim_token,protocol,model_id FROM task_runs WHERE task_id=$1 ORDER BY attempt',
      [taskId],
    )
  ).rows;
}

describe('COL-11 worker crash recovery', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('fences an expired current claim and writes at most one receipt-backed successor', async () => {
    let now = new Date('2026-09-06T01:00:00.000Z');
    const f = await taskFixture(cleanup, () => now);
    const queue = new TaskQueue(f.pool, () => now);
    const selected = await queue.claimNext();
    const claim = selected.claim;
    expect(claim).toMatchObject({
      runId: f.task.runs[0]!.id,
      taskId: f.task.id,
    });
    expect(
      (
        await f.pool.query('SELECT claim_token,expires_at FROM task_run_leases WHERE run_id=$1', [
          claim!.runId,
        ])
      ).rows,
    ).toEqual([
      {
        claim_token: claim!.claimToken,
        expires_at: new Date(now.getTime() + CLAIM_LEASE_MS),
      },
    ]);

    now = new Date(now.getTime() + CLAIM_LEASE_MS + 1);
    expect(
      await queue.finish(claim!, {
        body: 'This late completion must not be published.',
        usage: { inputTokens: 3, outputTokens: 5 },
      }),
    ).toBe(false);
    await expect(queue.publishDelta(claim!, 'Late delta.')).rejects.toMatchObject({
      code: 'worker_stopped',
    });
    expect(await f.read()).toMatchObject({
      status: 'running',
      runCount: 1,
      runs: [{ id: claim!.runId, status: 'running', error: null, output: null }],
    });

    expect(await queue.recoverExpiredClaims()).toBe(1);
    const runs = await taskRuns(f.pool, f.task.id);
    expect(runs).toMatchObject([
      {
        id: claim!.runId,
        attempt: 1,
        status: 'failed',
        error_code: 'worker_interrupted',
        claim_token: claim!.claimToken,
        protocol: claim!.provider.protocol,
        model_id: claim!.provider.modelId,
      },
      { attempt: 2, status: 'queued', error_code: null, claim_token: null },
    ]);
    const receipt = (
      await f.pool.query<{
        successor_run_id: string;
        decision: string;
        stop_reason: string | null;
      }>(
        'SELECT successor_run_id,decision,stop_reason FROM task_run_recovery_receipts WHERE source_run_id=$1',
        [claim!.runId],
      )
    ).rows[0];
    expect(receipt).toEqual({
      successor_run_id: runs[1]!.id,
      decision: 'queued_successor',
      stop_reason: null,
    });
    expect(
      (
        await f.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1",
          [runs[1]!.id],
        )
      ).rows[0]!.metadata,
    ).toMatchObject({
      origin: 'worker_recovery',
      sourceRunId: claim!.runId,
      previousRunId: claim!.runId,
      reason: 'worker_interrupted',
      chainRootRunId: claim!.runId,
      chainAttemptOrdinal: 2,
    });
    expect(await f.read()).toMatchObject({
      status: 'queued',
      runCount: 2,
      runs: [{ id: runs[1]!.id, attempt: 2, status: 'queued', error: null }],
    });

    expect(await queue.recoverExpiredClaims()).toBe(0);
    expect((await taskRuns(f.pool, f.task.id)).map((run) => run.id)).toEqual(
      runs.map((run) => run.id),
    );
    expect(
      (await f.pool.query('SELECT source_run_id FROM task_run_recovery_receipts')).rows,
    ).toHaveLength(1);
    expect(
      await queue.finish(claim!, {
        body: 'Still late.',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toBe(false);
    expect((await taskRuns(f.pool, f.task.id))[0]).toMatchObject({
      status: 'failed',
      error_code: 'worker_interrupted',
      claim_token: claim!.claimToken,
    });
  });

  it('renews an unexpired lease and refuses renewal after expiry', async () => {
    let now = new Date('2026-09-06T02:00:00.000Z');
    const f = await taskFixture(cleanup, () => now);
    const queue = new TaskQueue(f.pool, () => now);
    const claim = (await queue.claimNext()).claim!;
    expect(await queue.renewClaimLease(claim)).toBe(true);
    const first = (
      await f.pool.query<{ expires_at: Date; heartbeat_at: Date }>(
        'SELECT expires_at,heartbeat_at FROM task_run_leases WHERE run_id=$1',
        [claim.runId],
      )
    ).rows[0]!;
    expect(first.expires_at).toEqual(new Date(now.getTime() + CLAIM_LEASE_MS));
    now = new Date(now.getTime() + 1_000);
    expect(await queue.renewClaimLease(claim)).toBe(true);
    const renewed = (
      await f.pool.query<{ expires_at: Date; heartbeat_at: Date }>(
        'SELECT expires_at,heartbeat_at FROM task_run_leases WHERE run_id=$1',
        [claim.runId],
      )
    ).rows[0]!;
    expect(renewed.heartbeat_at.getTime()).toBeGreaterThan(first.heartbeat_at.getTime());
    expect(renewed.expires_at).toEqual(new Date(now.getTime() + CLAIM_LEASE_MS));
    now = new Date(renewed.expires_at.getTime() + 1);
    expect(await queue.renewClaimLease(claim)).toBe(false);
    expect(
      (await f.pool.query('SELECT expires_at FROM task_run_leases WHERE run_id=$1', [claim.runId]))
        .rows[0],
    ).toEqual({ expires_at: renewed.expires_at });
  });

  it('does not recover a completed Task or send it to a provider again', async () => {
    let now = new Date('2026-09-06T03:00:00.000Z');
    const f = await taskFixture(cleanup, () => now);
    const queue = new TaskQueue(f.pool, () => now);
    const claim = (await queue.claimNext()).claim!;
    expect(await queue.finish(claim, { body: 'Final answer.', usage: null })).toBe(true);
    now = new Date(now.getTime() + CLAIM_LEASE_MS + 1);
    expect(await queue.recoverExpiredClaims()).toBe(0);
    expect(await taskRuns(f.pool, f.task.id)).toMatchObject([
      { attempt: 1, status: 'completed', error_code: null },
    ]);
    let calls = 0;
    await f
      .worker(async () => {
        calls++;
        throw new Error('must not call provider');
      })
      .runOnce();
    expect(calls).toBe(0);
    expect(await taskRuns(f.pool, f.task.id)).toMatchObject([
      { attempt: 1, status: 'completed', error_code: null },
    ]);
  });
});

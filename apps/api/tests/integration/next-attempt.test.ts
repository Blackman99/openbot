import { afterEach, describe, expect, it } from 'vitest';
import { TaskQueue } from '../../src/tasks/queue.js';
import { writeNextAttempt } from '../../src/tasks/next-attempt.js';
import { planNextAttempt } from '../../src/tasks/retry-schedule.js';
import { modelFailure } from '../../src/providers/failure-taxonomy.js';
import { taskFixture } from '../helpers/task-fixture.js';
import { installTaskCancellationFixture } from '../helpers/task-cancellation-fixture.js';
type TaskRunRow = {
  id: string;
  attempt: number;
  status: string;
  error_code: string | null;
  created_at: Date;
};

async function taskRuns(
  pool: {
    query: (statement: string, parameters?: unknown[]) => Promise<{ rows: TaskRunRow[] }>;
  },
  taskId: string,
) {
  return (
    await pool.query(
      'SELECT id,attempt,status,error_code,created_at FROM task_runs WHERE task_id=$1 ORDER BY attempt',
      [taskId],
    )
  ).rows;
}

describe('COL-10 unique next-attempt writer', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('retries only a due queued Run after a transient failure and never redraws notBefore', async () => {
    let now = new Date('2026-09-05T12:00:00.000Z');
    const f = await taskFixture(cleanup, () => now, {
      retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
    });
    const worker = f.worker(async () => ({
      events: [{ type: 'text', text: 'Partial draft.' }],
      raw: '',
      error: modelFailure('provider_rate_limited'),
    }));
    expect(await worker.runOnce()).toBe(true);
    const waiting = await f.read();
    expect(waiting.status).toBe('queued');
    expect(waiting.runCount).toBe(2);
    expect(waiting.runs[0]).toMatchObject({ status: 'queued', error: null, provider: null });
    const runs = await taskRuns(f.pool, waiting.id);
    expect(runs).toMatchObject([
      { attempt: 1, status: 'failed', error_code: 'provider_failed' },
      { attempt: 2, status: 'queued', error_code: null },
    ]);
    const queuedAudit = (
      await f.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1",
        [runs[1]!.id],
      )
    ).rows[0]!.metadata;
    const notBefore = Date.parse(String(queuedAudit.notBefore));
    expect(notBefore).toBeGreaterThan(now.getTime());
    expect(new Date(runs[1]!.created_at).getTime()).toBe(now.getTime());
    expect(await worker.runOnce()).toBe(false);
    expect((await taskRuns(f.pool, waiting.id)).map((run) => run.status)).toEqual([
      'failed',
      'queued',
    ]);
    expect(queuedAudit).toMatchObject({
      origin: 'provider_retry',
      sourceRunId: runs[0]!.id,
      previousRunId: runs[0]!.id,
      reason: 'provider_rate_limited',
      chainRootRunId: runs[0]!.id,
      chainAttemptOrdinal: 2,
    });
    now = new Date(notBefore);
    let calls = 0;
    const retry = f.worker(async () => {
      calls++;
      return {
        events: [
          { type: 'text', text: 'Recovered answer.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      };
    });
    expect(await retry.runOnce()).toBe(true);
    expect(calls).toBe(1);
    expect(await f.read()).toMatchObject({
      status: 'completed',
      runCount: 2,
      runs: [{ status: 'completed', output: { sequence: expect.any(Number) } }],
    });
    expect((await taskRuns(f.pool, waiting.id)).map((run) => run.status)).toEqual([
      'failed',
      'completed',
    ]);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toHaveLength(1);
    expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
    expect(Date.parse(String(queuedAudit.notBefore))).toBe(notBefore);
  });

  it('does not schedule authentication failures or coarse provider_failed and keeps one Task', async () => {
    const f = await taskFixture(cleanup, () => new Date(), {
      retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
    });
    expect(
      await f
        .worker(async () => ({
          events: [],
          raw: '',
          error: modelFailure('provider_authentication_failed'),
        }))
        .runOnce(),
    ).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runCount: 1,
      runs: [{ status: 'failed', error: 'provider_failed' }],
    });
    expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('writes at most one successor and refuses cancelled ancestry without fabricating a retry command', async () => {
    let now = new Date('2026-09-05T12:00:00.000Z');
    const f = await taskFixture(cleanup, () => now, {
      retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
    });
    await f
      .worker(async () => ({
        events: [],
        raw: '',
        error: modelFailure('provider_unavailable'),
      }))
      .runOnce();
    const first = await f.read();
    const firstRuns = await taskRuns(f.pool, first.id);
    expect(firstRuns).toHaveLength(2);
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      const duplicate = await writeNextAttempt(connection, {
        taskId: first.id,
        sourceRunId: firstRuns[0]!.id,
        workspaceId: f.owner.workspace.id,
        conversationId: f.conversation.id,
        executionUserId: f.owner.user.id,
        sourceAttempt: 1,
        plan: planNextAttempt({
          failure: modelFailure('provider_unavailable'),
          configuration: {
            modelBinding: {
              scope: { kind: 'personal', id: f.owner.user.id },
              connectionId: f.model.id,
              modelId: f.model.modelId,
            },
            retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
          },
          chain: {
            rootRunId: firstRuns[0]!.id,
            previousRunId: firstRuns[0]!.id,
            attempts: [
              {
                runId: firstRuns[0]!.id,
                connectionId: f.model.id,
                modelId: f.model.modelId,
                origin: 'initial',
              },
            ],
          },
          now,
          jitterMs: 0,
        })!,
        now,
      });
      await connection.query('COMMIT');
      expect(duplicate).toEqual({ scheduled: false, reason: 'duplicate' });
    } finally {
      connection.release();
    }
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(2);
    expect((await f.pool.query('SELECT id FROM task_retry_commands')).rows).toHaveLength(0);

    const cancelled = await taskFixture(cleanup, () => now, {
      retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
    });
    await installTaskCancellationFixture(cancelled.pool);
    await cancelled
      .worker(async () => ({
        events: [],
        raw: '',
        error: modelFailure('provider_connection_reset'),
      }))
      .runOnce();
    const queued = await cancelled.read();
    const queuedRuns = await taskRuns(cancelled.pool, queued.id);
    await cancelled.tasks.cancel(
      cancelled.owner.user.id,
      cancelled.owner.workspace.id,
      cancelled.conversation.id,
      queued.id,
      { idempotencyKey: 'stop-automatic-retry', expectedRunId: queuedRuns[1]!.id },
    );
    const cancelConnection = await cancelled.pool.connect();
    try {
      await cancelConnection.query('BEGIN');
      const refused = await writeNextAttempt(cancelConnection, {
        taskId: queued.id,
        sourceRunId: queuedRuns[0]!.id,
        workspaceId: cancelled.owner.workspace.id,
        conversationId: cancelled.conversation.id,
        executionUserId: cancelled.owner.user.id,
        sourceAttempt: 1,
        plan: planNextAttempt({
          failure: modelFailure('provider_connection_reset'),
          configuration: {
            modelBinding: {
              scope: { kind: 'personal', id: cancelled.owner.user.id },
              connectionId: cancelled.model.id,
              modelId: cancelled.model.modelId,
            },
            retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
          },
          chain: {
            rootRunId: queuedRuns[0]!.id,
            previousRunId: queuedRuns[0]!.id,
            attempts: [
              {
                runId: queuedRuns[0]!.id,
                connectionId: cancelled.model.id,
                modelId: cancelled.model.modelId,
                origin: 'initial',
              },
            ],
          },
          now,
          jitterMs: 0,
        })!,
        now,
      });
      await cancelConnection.query('COMMIT');
      expect(refused).toEqual({ scheduled: false, reason: 'cancelled' });
    } finally {
      cancelConnection.release();
    }
    expect((await cancelled.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(2);
  });

  it('schedules only a configured fallback after the per-model cap and claims that binding when due', async () => {
    let now = new Date('2026-09-05T12:00:00.000Z');
    const f = await taskFixture(cleanup, () => now, {
      retryPolicy: { maxAttemptsPerModel: 1, maxRunsPerChain: 4 },
      fallbackModel: true,
    });
    expect(
      await f
        .worker(async () => ({
          events: [],
          raw: '',
          error: modelFailure('provider_unavailable'),
        }))
        .runOnce(),
    ).toBe(true);
    const waiting = await f.read();
    expect(waiting.status).toBe('queued');
    expect(waiting.runCount).toBe(2);
    const runs = await taskRuns(f.pool, waiting.id);
    const queuedAudit = (
      await f.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1",
        [runs[1]!.id],
      )
    ).rows[0]!.metadata;
    expect(queuedAudit).toMatchObject({
      origin: 'model_fallback',
      reason: 'provider_unavailable',
      previousBinding: { connectionId: f.model.id, modelId: f.model.modelId },
      binding: { connectionId: f.fallback!.id, modelId: f.fallback!.modelId },
      previousProvider: { protocol: 'openai-chat', modelId: f.model.modelId },
      nextProvider: { protocol: 'openai-chat', modelId: f.fallback!.modelId },
    });
    expect(JSON.stringify(queuedAudit)).not.toMatch(/never-return|baseUrl|apiKey|sealed/u);
    expect(waiting.runs[0]).toMatchObject({
      continuation: {
        origin: 'model_fallback',
        reason: 'provider_unavailable',
        previousRunId: runs[0]!.id,
        previousProvider: { protocol: 'openai-chat', modelId: f.model.modelId },
        nextProvider: { protocol: 'openai-chat', modelId: f.fallback!.modelId },
        admitted: false,
      },
    });
    const queuedDelivery = (
      await f.pool.query<{ execution: { continuation?: object } }>(
        "SELECT execution FROM conversation_delivery_events WHERE run_id=$1 AND run_status='queued'",
        [runs[1]!.id],
      )
    ).rows[0]!.execution;
    expect(queuedDelivery.continuation).toMatchObject({
      origin: 'model_fallback',
      reason: 'provider_unavailable',
      previousProvider: { protocol: 'openai-chat', modelId: f.model.modelId },
      nextProvider: { protocol: 'openai-chat', modelId: f.fallback!.modelId },
      admitted: false,
    });
    const due = Date.parse(String(queuedAudit.notBefore));
    expect(due).toBeGreaterThan(now.getTime());
    now = new Date(due);
    expect(await new TaskQueue(f.pool, () => now).claimNext()).toMatchObject({
      handled: true,
      claim: { provider: { connectionId: f.fallback!.id, modelId: f.fallback!.modelId } },
    });
    const claimed = await f.read();
    expect(claimed.runs[0]).toMatchObject({
      status: 'running',
      continuation: {
        origin: 'model_fallback',
        reason: 'provider_unavailable',
        previousProvider: { protocol: 'openai-chat', modelId: f.model.modelId },
        nextProvider: { protocol: 'openai-chat', modelId: f.fallback!.modelId },
        admitted: true,
      },
    });
    const runningAudit = (
      await f.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.running' AND metadata->>'runId'=$1",
        [runs[1]!.id],
      )
    ).rows[0]!.metadata;
    expect(runningAudit.continuation).toMatchObject({
      origin: 'model_fallback',
      reason: 'provider_unavailable',
      previousProvider: { protocol: 'openai-chat', modelId: f.model.modelId },
      nextProvider: { protocol: 'openai-chat', modelId: f.fallback!.modelId },
      admitted: true,
    });
    expect(JSON.stringify(runningAudit.continuation)).not.toMatch(
      /connectionId|connectionRevision|baseUrl|apiKey|sealed/u,
    );
    expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('keeps an absent legacy retry policy as a single failed Run even for allowlisted codes', async () => {
    const f = await taskFixture(cleanup);
    const queue = new TaskQueue(f.pool);
    const selected = await queue.claimNext();
    expect(
      await queue.finish(selected.claim!, {
        error: 'provider_failed',
        usage: null,
        modelFailure: modelFailure('provider_rate_limited'),
      }),
    ).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runCount: 1,
      runs: [{ status: 'failed', error: 'provider_failed' }],
    });
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(1);
  });
});

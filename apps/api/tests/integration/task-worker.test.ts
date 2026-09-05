import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import { randomUUID } from 'node:crypto';
import { ConversationAccessError } from '../../src/conversations/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import type { ModelEventConsumer, ModelResponse } from '../../src/providers/model-events.js';

describe('Task execution authority and terminal outcomes', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('aborts a silent provider when another transaction ends its durable claim', async () => {
    const f = await taskFixture(cleanup);
    let announce!: (signal: AbortSignal) => void;
    let respond!: (response: ModelResponse) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      announce = resolve;
    });
    const response = new Promise<ModelResponse>((resolve) => {
      respond = resolve;
    });
    let workerFinished = false;
    let emit: ModelEventConsumer | undefined;
    const running = f
      .worker(async (_input, signal, onEvent) => {
        emit = onEvent;
        announce(signal!);
        return response;
      })
      .runOnce()
      .then((handled) => {
        workerFinished = true;
        return handled;
      });
    const providerSignal = await started;
    const connection = await f.pool.connect();
    try {
      // Another process owns this valid terminal transition. The cancellation
      // state will use the same observation seam after standalone migration0023.
      await connection.query('BEGIN');
      await connection.query(
        "UPDATE task_runs SET status='failed',finished_at=$2,error_code='worker_stopped' WHERE id=$1",
        [f.task.runs[0]!.id, new Date()],
      );
      await connection.query("UPDATE tasks SET status='failed' WHERE id=$1", [f.task.id]);
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.failed',$2,$3,$4::jsonb)",
        [randomUUID(), f.owner.user.id, new Date(), JSON.stringify({ taskId: f.task.id })],
      );
      await connection.query('COMMIT');
      await expect.poll(() => providerSignal.aborted, { timeout: 1500 }).toBe(true);
      // A provider that ignores abort must not hold this worker invocation open.
      await expect.poll(() => workerFinished, { timeout: 1500 }).toBe(true);
      await expect(
        Promise.resolve().then(() => emit?.({ type: 'text', text: 'Late callback.' })),
      ).rejects.toThrow();
    } finally {
      connection.release();
      respond({
        events: [
          { type: 'text', text: 'This late completion must not be published.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      });
      await running;
    }
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runs: [{ status: 'failed', error: 'worker_stopped', output: null }],
    });
    expect(
      (await f.pool.query("SELECT id FROM audit_events WHERE event_type='task.failed'")).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('rechecks provider authority after the complete generation promise and never publishes a disabled provider result', async () => {
    const f = await taskFixture(cleanup);
    const worker = f.worker(async (_input, _signal, onEvent) => {
      await onEvent?.({ type: 'complete', stopReason: 'stop' });
      await f.providers.disable(f.owner.user.id, f.model.id);
      return {
        events: [
          { type: 'text', text: 'Must not publish.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      };
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runs: [{ status: 'failed', error: 'model_unavailable', output: null }],
    });
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('keeps Bot completion independent of a human-selected idempotency key', async () => {
    const f = await taskFixture(cleanup);
    const worker = f.worker(async () => {
      await f.conversations.append(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
        idempotencyKey: `bot-output:${f.task.runs[0]!.id}`,
        body: 'An unrelated human message.',
      });
      return {
        events: [
          { type: 'text', text: 'Independent output.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      };
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'completed',
      // Trigger, queued, running and the unrelated human message precede output
      // on the shared durable conversation sequence.
      runs: [{ output: { sequence: 5 } }],
    });
  });
  it.each(['final-error', 'oversize', 'usage-limit', 'no-complete', 'no-text', 'action'] as const)(
    'records %s as a safe failed attempt without promoting streamed partial output',
    async (scenario) => {
      const f = await taskFixture(cleanup);
      const worker = f.worker(async (_input, _signal, onEvent) => {
        await onEvent?.({ type: 'text', text: 'Partial draft.' });
        await onEvent?.({ type: 'usage', inputTokens: 5, outputTokens: 3 });
        await onEvent?.({ type: 'complete', stopReason: 'stop' });
        if (scenario === 'final-error')
          return {
            events: [{ type: 'text', text: 'Partial draft.' }],
            raw: 'https://secret.example Authorization: private-key',
            error: { code: 'provider_failed', category: 'retryable' },
          };
        if (scenario === 'oversize')
          return {
            events: [
              { type: 'text', text: '😀'.repeat(16001) },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        if (scenario === 'usage-limit')
          return {
            events: [
              { type: 'text', text: 'Over budget.' },
              { type: 'usage', inputTokens: 32768, outputTokens: 1 },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        if (scenario === 'no-complete')
          return { events: [{ type: 'text', text: 'Truncated stream.' }], raw: '' };
        if (scenario === 'no-text')
          return { events: [{ type: 'complete', stopReason: 'stop' }], raw: '' };
        return {
          events: [
            { type: 'action', id: 'call', name: 'unexpected', arguments: {} },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        };
      });
      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(false);
      const final = await f.read();
      expect(final).toMatchObject({
        status: 'failed',
        runs: [
          {
            status: 'failed',
            error: ['oversize', 'usage-limit'].includes(scenario)
              ? 'output_limit'
              : 'provider_failed',
            output: null,
          },
        ],
      });
      const events = await f.pool.query('SELECT event_type,body FROM conversation_events');
      expect(events.rows).toEqual([
        { event_type: 'message.created', body: 'Explain the evidence.' },
      ]);
      const audit = await f.pool.query(
        "SELECT metadata FROM audit_events WHERE event_type='task.failed'",
      );
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify([final, audit.rows])).not.toMatch(
        /secret\.example|private-key|Partial draft/,
      );
    },
  );
  it('enforces the persisted deadline and handles graceful worker stop without late success', async () => {
    let time = new Date();
    const f = await taskFixture(cleanup, () => time);
    const worker = f.worker(async () => {
      time = new Date(time.getTime() + 300001);
      return {
        events: [
          { type: 'text', text: 'Late.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      };
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runs: [{ error: 'execution_timeout', output: null }],
    });
    const second = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'second',
      body: 'Stop safely.',
    });
    const stopped = new AbortController();
    await f
      .worker(async () => {
        stopped.abort();
        return {
          events: [
            { type: 'text', text: 'Do not publish.' },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        };
      })
      .runOnce(stopped.signal);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, second.id),
    ).toMatchObject({ status: 'failed', runs: [{ error: 'worker_stopped', output: null }] });
  });
  it('fails queued work before a network call when its provider is disabled', async () => {
    const f = await taskFixture(cleanup);
    await f.providers.disable(f.owner.user.id, f.model.id);
    let calls = 0;
    expect(
      await f
        .worker(async () => {
          calls++;
          throw new Error('Must not call');
        })
        .runOnce(),
    ).toBe(true);
    expect(calls).toBe(0);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runs: [{ startedAt: null, provider: null, error: 'model_unavailable', output: null }],
    });
  });
  it('does not start a model request when the claim commit consumed the entire deadline', async () => {
    let now = new Date();
    const f = await taskFixture(cleanup, () => now);
    const slowCommit: SqlPool = {
      connect: async () => {
        const connection = await f.pool.connect();
        return {
          query: async (statement, parameters) => {
            const result = await connection.query(statement, parameters);
            if (statement === 'COMMIT') now = new Date(now.getTime() + 300001);
            return result;
          },
          release: () => connection.release(),
        };
      },
    };
    let calls = 0;
    const worker = new TaskWorker(
      slowCommit,
      {
        secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
        createAdapter: () => ({
          generate: async () => {
            calls++;
            return {
              events: [
                { type: 'text', text: 'Too late.' },
                { type: 'complete', stopReason: 'stop' },
              ],
              raw: '',
            };
          },
        }),
      },
      () => now,
    );
    expect(await worker.runOnce()).toBe(true);
    expect(calls).toBe(0);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runs: [{ error: 'execution_timeout', output: null }],
    });
  });
  it('fences stale and duplicate completion and denies human edits to Bot output', async () => {
    const f = await taskFixture(cleanup);
    const queue = new TaskQueue(f.pool);
    const selected = await queue.claimNext();
    expect(selected.claim).toBeDefined();
    const claim = selected.claim!;
    await expect(queue.isClaimActive(claim)).resolves.toBe(true);
    expect(
      await queue.finish({ ...claim, claimToken: randomUUID() }, { body: 'Stale.', usage: null }),
    ).toBe(false);
    expect((await f.read()).status).toBe('running');
    expect(await queue.finish(claim, { body: 'One output.', usage: null })).toBe(true);
    await expect(queue.isClaimActive(claim)).resolves.toBe(false);
    expect(await queue.finish(claim, { body: 'Duplicate.', usage: null })).toBe(false);
    const final = await f.read();
    const output = final.runs[0]!.output!;
    await expect(
      f.conversations.edit(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        output.messageId,
        { idempotencyKey: 'edit-bot', expectedVersion: 1, body: 'Forged edit.' },
      ),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    await expect(
      f.conversations.tombstone(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        output.messageId,
        { idempotencyKey: 'delete-bot', expectedVersion: 1 },
      ),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    await expect(
      f.conversations.versions(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        output.messageId,
      ),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await f.pool.query("SELECT id FROM audit_events WHERE event_type='task.completed'")).rows,
    ).toHaveLength(1);
  });
});

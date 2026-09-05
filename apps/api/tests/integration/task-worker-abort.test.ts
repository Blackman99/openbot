import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { createModelAdapter } from '../../src/providers/protocols.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { installTaskCancellationFixture } from '../helpers/task-cancellation-fixture.js';

describe('durable worker observation and the real provider transport', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it.each(['before-first-delta', 'after-first-delta'] as const)(
    'closes a silent HTTP request %s and can process the next Task',
    async (silence) => {
      const f = await taskFixture(cleanup);
      await installTaskCancellationFixture(f.pool);
      let announceRequest!: () => void;
      const requested = new Promise<void>((resolve) => {
        announceRequest = resolve;
      });
      let calls = 0,
        closed = false;
      const server = createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          calls++;
          if (calls === 1) {
            response.on('close', () => {
              closed = !response.writableFinished;
            });
            if (silence === 'after-first-delta') {
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              response.write('data: {"choices":[{"delta":{"content":"Visible prefix 🌱"}}]}\n\n');
            }
            announceRequest();
          } else {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(
              'data: {"choices":[{"delta":{"content":"Next answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            );
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanup.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing_provider_port');
      const policy = new ProviderUrlPolicy({
        hosts: ['127.0.0.1'],
        schemes: ['http'],
        privateCidrs: ['127.0.0.0/8'],
      });
      const secrets = new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64'));
      const providers = new ProviderConnections(
        new PostgresProviderRepository(f.pool),
        secrets,
        policy,
        {
          run: async () => ({
            testedAt: new Date().toISOString(),
            text: { ok: true, code: 'passed', raw: 'Text' },
            action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
          }),
        },
      );
      await providers.update(f.owner.user.id, f.model.id, {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const worker = new TaskWorker(f.pool, {
        secrets,
        createAdapter: (protocol, options) => createModelAdapter(protocol, policy, options),
      });
      const shutdown = new AbortController();
      const running = worker.runOnce(shutdown.signal);
      try {
        await requested;
        if (silence === 'after-first-delta')
          await expect
            .poll(
              async () =>
                (
                  await f.pool.query(
                    "SELECT delta_text FROM conversation_delivery_events WHERE run_id=$1 AND event_type='assistant.delta'",
                    [f.task.runs[0]!.id],
                  )
                ).rows,
              { timeout: 1500 },
            )
            .toEqual([{ delta_text: 'Visible prefix 🌱' }]);
        await f.tasks.cancel(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id, {
          idempotencyKey: 'stop-real-http',
          expectedRunId: f.task.runs[0]!.id,
        });
        await expect.poll(() => closed, { timeout: 1500 }).toBe(true);
        await expect(running).resolves.toBe(true);
      } finally {
        shutdown.abort();
        await running;
      }
      expect(calls).toBe(1);
      expect(await f.read()).toMatchObject({
        status: 'cancelled',
        runs: [{ output: null, error: null, usage: null }],
      });
      expect(
        await f.tasks.partialOutput(
          f.owner.user.id,
          f.owner.workspace.id,
          f.conversation.id,
          f.task.id,
          f.task.runs[0]!.id,
        ),
      ).toMatchObject({
        partial:
          silence === 'before-first-delta'
            ? null
            : {
                text: 'Visible prefix 🌱',
                endByte: Buffer.byteLength('Visible prefix 🌱'),
                interrupted: true,
              },
      });
      const next = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
        idempotencyKey: 'after-stopped-request',
        body: 'Continue with independent work.',
      });
      await expect(worker.runOnce()).resolves.toBe(true);
      expect(calls).toBe(2);
      expect(
        await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, next.id),
      ).toMatchObject({ status: 'completed' });
      expect(
        (
          await f.pool.query(
            "SELECT body FROM conversation_events WHERE event_type='bot.message.created'",
          )
        ).rows,
      ).toEqual([{ body: 'Next answer' }]);
    },
  );
});

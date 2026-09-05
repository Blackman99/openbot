import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { createModelAdapter } from '../../src/providers/protocols.js';
import { TaskWorker } from '../../src/tasks/worker.js';

describe('COL-10 real adapter to worker scheduling', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function workerAgainst(
    respond: (request: IncomingMessage, response: ServerResponse) => void,
  ) {
    const f = await taskFixture(cleanup, () => new Date(), {
      retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
      fallbackModel: true,
    });
    let calls = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        calls += 1;
        respond(request, response);
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
    return { f, worker, calls: () => calls };
  }

  it.each([
    [
      'HTTP 401 authentication',
      (response: ServerResponse) => {
        response.writeHead(401);
        response.end('invalid_api_key');
      },
    ],
    [
      'SSE invalid_api_key authentication',
      (response: ServerResponse) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"error":{"code":"invalid_api_key"}}\n\n');
      },
    ],
    [
      'HTTP 400 validation',
      (response: ServerResponse) => {
        response.writeHead(400);
        response.end('{"error":{"code":"invalid_request"}}');
      },
    ],
    [
      'malformed SSE validation',
      (response: ServerResponse) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: []\n\n');
      },
    ],
  ] as const)('does not retry or fall back after %s and keeps one Task', async (_name, respond) => {
    const { f, worker, calls } = await workerAgainst(respond);
    expect(await worker.runOnce()).toBe(true);
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
    expect(calls()).toBe(1);
  });

  it('schedules one same-model retry after a real HTTP 503 and does not call the fallback', async () => {
    const { f, worker, calls } = await workerAgainst((response) => {
      response.writeHead(503);
      response.end('temporarily unavailable');
    });
    expect(await worker.runOnce()).toBe(true);
    const waiting = await f.read();
    expect(waiting).toMatchObject({
      status: 'queued',
      runCount: 2,
    });
    const queued = (
      await f.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.queued' ORDER BY occurred_at DESC LIMIT 1",
      )
    ).rows[0]!.metadata;
    expect(queued).toMatchObject({
      origin: 'provider_retry',
      reason: 'provider_unavailable',
      binding: { connectionId: f.model.id, modelId: f.model.modelId },
    });
    expect(queued.binding).not.toMatchObject({ connectionId: f.fallback!.id });
    expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toHaveLength(0);
    expect(calls()).toBe(1);
  });
});

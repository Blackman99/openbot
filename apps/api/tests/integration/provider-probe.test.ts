import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiChatProbe } from '../../src/providers/openai-chat-probe.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function mock(mode = 'success') {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as Record<string, unknown>;
    requests.push(payload);
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer test-api-secret');
    expect(request.headers['x-provider-token']).toBe('test-header-secret');
    if (mode === 'auth') {
      response.writeHead(401);
      response.end('Bearer test-api-secret test-header-secret');
      return;
    }
    if (mode === 'timeout') return;
    if (mode === 'redirect') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest' });
      response.end();
      return;
    }
    if (mode === 'oversized') {
      response.end('x'.repeat(70_000));
      return;
    }
    if (payload.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        'data: {"choices":[{"delta":{"content":"OK test-api-secret test-header-secret"},"finish_reason":null}]}\n\n',
      );
      if (mode === 'socket-interrupted') {
        setTimeout(() => response.destroy(), 15);
        return;
      }
      if (mode === 'interrupted') {
        response.end();
        return;
      }
      if (mode === 'stream-error') {
        response.write('data: {"error":{"message":"secret-api-secret"}}\n\n');
      }
      response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: mode === 'truncated-action' ? 'length' : 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: 'probe-call',
                    type: 'function',
                    function: { name: 'openbot_probe', arguments: '{"ok":true}' },
                  },
                ],
              },
            },
          ],
        }),
      );
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no mock port');
  const input = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    modelId: 'mock-model',
    apiKey: 'test-api-secret',
    headers: { 'x-provider-token': 'test-header-secret' },
  };
  return { input, requests };
}

function probe(timeoutMs = 1000) {
  return new OpenAiChatProbe(
    new ProviderUrlPolicy({
      hosts: ['127.0.0.1'],
      schemes: ['http'],
      privateCidrs: ['127.0.0.0/8'],
    }),
    { timeoutMs, clock: () => new Date('2030-01-02T00:00:00Z') },
  );
}

describe('OpenAI Chat compatibility probe', () => {
  it('performs live SSE text and forced structured tool probes with sanitized timestamped raw evidence', async () => {
    const { input, requests } = await mock();
    const report = await probe().run(input);
    expect(report).toMatchObject({
      testedAt: '2030-01-02T00:00:00.000Z',
      text: { ok: true },
      action: { ok: true },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: 'mock-model', stream: true });
    expect(requests[1]).toMatchObject({
      model: 'mock-model',
      tool_choice: { type: 'function', function: { name: 'openbot_probe' } },
    });
    expect(report.text.raw).toContain('[REDACTED]');
    expect(JSON.stringify(report)).not.toMatch(/test-api-secret|test-header-secret/u);
  });
  it('does not treat a truncated function result as supported structured actions', async () => {
    const { input } = await mock('truncated-action');
    const report = await probe().run(input);
    expect(report.text.ok).toBe(true);
    expect(report.action).toMatchObject({ ok: false, code: 'provider_action_unsupported' });
  });
  it('redacts header secrets after HTTP whitespace trimming', async () => {
    const { input } = await mock('auth');
    input.headers['x-provider-token'] = '  test-header-secret  ';
    const report = await probe().run(input);
    expect(report.text.code).toBe('provider_authentication_failed');
    expect(JSON.stringify(report)).not.toContain('test-header-secret');
  });
  it('retains sanitized partial raw evidence when the response socket breaks', async () => {
    const { input } = await mock('socket-interrupted');
    const report = await probe().run(input);
    expect(report.text).toMatchObject({ ok: false, code: 'provider_connection_reset' });
    expect(report.text.raw).toContain('data:');
    expect(report.text.raw).toContain('OK');
    expect(JSON.stringify(report)).not.toMatch(/test-api-secret|test-header-secret/u);
  });
  it.each([
    ['auth', 'provider_authentication_failed'],
    ['timeout', 'provider_timeout'],
    ['interrupted', 'provider_interrupted_stream'],
    ['redirect', 'provider_request_failed'],
    ['oversized', 'provider_response_too_large'],
    ['stream-error', 'provider_request_failed'],
  ])('reports %s safely', async (mode, code) => {
    const { input } = await mock(mode);
    const result = await probe(80).run(input);
    expect(result.text).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toMatch(/test-api-secret|test-header-secret/u);
  });
  it('cancels an in-flight request and bounds a stalled DNS lookup', async () => {
    const { input } = await mock('timeout');
    const controller = new AbortController();
    const running = probe().run(input, controller.signal);
    controller.abort();
    expect((await running).text.code).toBe('provider_cancelled');
    const policy = new ProviderUrlPolicy(
      { hosts: ['slow.example'], schemes: ['https'], privateCidrs: [] },
      async () => new Promise(() => {}),
    );
    const dnsProbe = new OpenAiChatProbe(policy, { timeoutMs: 20 });
    expect((await dnsProbe.run({ ...input, baseUrl: 'https://slow.example/v1' })).text.code).toBe(
      'provider_timeout',
    );
  });
});

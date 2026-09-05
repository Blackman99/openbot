import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicMessagesAdapter } from '../../src/providers/anthropic-messages.js';
import { ProtocolConnectionProbe } from '../../src/providers/protocols.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import type { ModelEvent } from '../../src/providers/model-events.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function frame(value: Record<string, unknown>): string {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function textStart(): string {
  return (
    frame({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }) +
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello 世界' },
    })
  );
}

function textEnd(): string {
  return (
    frame({ type: 'content_block_stop', index: 0 }) +
    frame({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    }) +
    frame({ type: 'message_stop' })
  );
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function mock(handler: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const requests: {
    path: string | undefined;
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push({ path: request.url, headers: request.headers, body });
    handler(body, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock port missing');
  return {
    requests,
    input: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'mock-anthropic',
      apiKey: 'test-api-secret',
      anthropicVersion: '2023-06-01',
      headers: { 'x-provider-token': 'test-header-secret' },
      messages: [{ role: 'user' as const, content: 'Hello' }],
      stream: false,
    },
  };
}

function adapter(timeoutMs = 1_000) {
  return new AnthropicMessagesAdapter(
    new ProviderUrlPolicy({
      hosts: ['127.0.0.1'],
      schemes: ['http'],
      privateCidrs: ['127.0.0.0/8'],
    }),
    { timeoutMs },
  );
}

describe('Anthropic Messages HTTP contract', () => {
  it('sends explicit version/key/custom headers and top-level system, normalizing a plain text message', async () => {
    const { input, requests } = await mock((_body, response) =>
      response.end(
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      ),
    );
    const result = await adapter().generate({
      ...input,
      maxOutputTokens: 512,
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'complete', stopReason: 'end_turn' },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/messages',
      headers: {
        'x-api-key': 'test-api-secret',
        'anthropic-version': '2023-06-01',
        'x-provider-token': 'test-header-secret',
      },
      body: {
        model: 'mock-anthropic',
        max_tokens: 512,
        system: 'Be helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });
  it('maps a forced local tool schema and parses structured tool_use arguments', async () => {
    const { input, requests } = await mock((_body, response) =>
      response.end(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'openbot_probe', input: { ok: true } }],
          stop_reason: 'tool_use',
        }),
      ),
    );
    const result = await adapter().generate({
      ...input,
      tools: [
        {
          name: 'openbot_probe',
          description: 'Check tool support',
          parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        },
      ],
      toolChoice: 'openbot_probe',
    });
    expect(result.events).toContainEqual({
      type: 'action',
      id: 'tool-1',
      name: 'openbot_probe',
      arguments: { ok: true },
    });
    expect(requests[0]?.body).toMatchObject({
      tools: [
        {
          name: 'openbot_probe',
          description: 'Check tool support',
          input_schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'openbot_probe' },
    });
  });
  it('delivers streaming text before the server completes and keeps cumulative usage', async () => {
    const textSeen = deferred<void>();
    const finishResponse = deferred<ServerResponse>();
    const events: ModelEvent[] = [];
    const { input } = await mock((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(textStart());
      finishResponse.resolve(response);
    });
    const running = adapter().generate({ ...input, stream: true }, undefined, (event) => {
      events.push(event);
      if (event.type === 'text') textSeen.resolve();
    });
    await textSeen.promise;
    expect(events).toContainEqual({ type: 'text', text: 'Hello 世界' });
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    (await finishResponse.promise).end(textEnd());
    const result = await running;
    expect(result.error).toBeUndefined();
    expect(result.events).toEqual(events);
    expect(events.slice(-2)).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'complete', stopReason: 'end_turn' },
    ]);
  });
  it.each([
    [401, 'provider_authentication_failed', 'non_retryable'],
    [403, 'provider_authentication_failed', 'non_retryable'],
    [429, 'provider_rate_limited', 'retryable'],
    [529, 'provider_request_failed', 'non_retryable'],
    [500, 'provider_unavailable', 'retryable'],
    [501, 'provider_request_failed', 'non_retryable'],
    [400, 'provider_request_failed', 'non_retryable'],
    [302, 'provider_request_failed', 'non_retryable'],
  ])('normalizes HTTP %s and sanitizes reflected credentials', async (status, code, category) => {
    const { input } = await mock((_body, response) => {
      response.writeHead(status as number, { location: 'http://169.254.169.254/latest' });
      response.end('test-api-secret test-header-secret');
    });
    const result = await adapter().generate(input);
    expect(result.error).toEqual({ code, category });
    expect(result.events).toEqual([]);
    expect(result.raw).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toMatch(/test-api-secret|test-header-secret/u);
  });
  it('cancels and closes an active stream after a delivered text event', async () => {
    const closed = deferred<void>();
    const { input } = await mock((_body, response) => {
      response.on('close', () => closed.resolve());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(textStart());
    });
    const controller = new AbortController();
    const result = await adapter().generate(
      { ...input, stream: true },
      controller.signal,
      (event) => {
        if (event.type === 'text') controller.abort();
      },
    );
    expect(result.error).toEqual({ code: 'provider_cancelled', category: 'non_retryable' });
    expect(result.events.some((event) => event.type === 'complete')).toBe(false);
    await closed.promise;
  });
  it('bounds an unresponsive upstream request', async () => {
    const { input } = await mock(() => {});
    const result = await adapter(40).generate(input);
    expect(result.error).toEqual({ code: 'provider_timeout', category: 'non_retryable' });
  });
  it('requires message_stop and preserves safe evidence on EOF', async () => {
    const { input } = await mock((_body, response) => response.end(textStart()));
    const result = await adapter().generate({ ...input, stream: true });
    expect(result.error).toEqual({
      code: 'provider_interrupted_stream',
      category: 'non_retryable',
    });
    expect(result.raw).toContain('Hello 世界');
    expect(result.events.some((event) => event.type === 'complete')).toBe(false);
  });
  it('retries HTTP 529 only when the overloaded envelope is present', async () => {
    const { input } = await mock((_body, response) => {
      response.writeHead(529);
      response.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'busy' } }));
    });
    expect(await adapter().generate(input)).toMatchObject({
      error: { code: 'provider_unavailable', category: 'retryable' },
    });
  });
  it('maps an upstream overloaded error inside an otherwise successful HTTP response', async () => {
    const { input } = await mock((_body, response) =>
      response.end(
        frame({
          type: 'error',
          error: { type: 'overloaded_error', message: 'test-api-secret test-header-secret' },
        }),
      ),
    );
    const result = await adapter().generate({ ...input, stream: true });
    expect(result.error).toEqual({ code: 'provider_unavailable', category: 'retryable' });
    expect(result.raw).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toMatch(/test-api-secret|test-header-secret/u);
  });
  it.each([true, false])(
    'records text and action probe evidence with tool support %s',
    async (supportsTools) => {
      const { input, requests } = await mock((body, response) => {
        if (body.stream) response.end(textStart() + textEnd());
        else
          response.end(
            JSON.stringify({
              type: 'message',
              content: supportsTools
                ? [{ type: 'tool_use', id: 'probe-1', name: 'openbot_probe', input: { ok: true } }]
                : [{ type: 'text', text: 'Tools unavailable' }],
              stop_reason: supportsTools ? 'tool_use' : 'end_turn',
            }),
          );
      });
      const probe = new ProtocolConnectionProbe(
        new ProviderUrlPolicy({
          hosts: ['127.0.0.1'],
          schemes: ['http'],
          privateCidrs: ['127.0.0.0/8'],
        }),
        { clock: () => new Date('2030-01-02T00:00:00Z') },
      );
      const report = await probe.run({ ...input, protocol: 'anthropic-messages' });
      expect(report.testedAt).toBe('2030-01-02T00:00:00.000Z');
      expect(report.text).toMatchObject({ ok: true, code: 'passed' });
      expect(report.action).toMatchObject({
        ok: supportsTools,
        code: supportsTools ? 'passed' : 'provider_action_unsupported',
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.body).toMatchObject({
        tool_choice: { type: 'tool', name: 'openbot_probe' },
      });
    },
  );
  it('normalizes a JSON error envelope from a compatibility endpoint returning HTTP 200', async () => {
    const { input } = await mock((_body, response) =>
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'test-api-secret' },
        }),
      ),
    );
    const result = await adapter().generate(input);
    expect(result.error).toEqual({ code: 'provider_unavailable', category: 'retryable' });
    expect(result.raw).not.toContain('test-api-secret');
  });
});

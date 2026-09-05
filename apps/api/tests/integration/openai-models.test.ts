import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { OpenAiChatAdapter } from '../../src/providers/openai-chat.js';
import { OpenAiResponsesAdapter } from '../../src/providers/openai-responses.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const policy = new ProviderUrlPolicy({
  hosts: ['127.0.0.1'],
  schemes: ['http'],
  privateCidrs: ['127.0.0.0/8'],
});
async function mock(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    modelId: 'reasoner',
    apiKey: 'secret-key',
    headers: { 'x-token': 'secret-header' },
    messages: [{ role: 'user' as const, content: 'Tell me about stars.' }],
    stream: false,
  };
}

it('normalizes ordinary Responses text with usage and sends the chosen endpoint, model and credentials', async () => {
  let observed: unknown;
  const input = await mock((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      observed = {
        path: request.url,
        authorization: request.headers.authorization,
        token: request.headers['x-token'],
        body: JSON.parse(body),
      };
      response.end(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'Stars make light.' }] },
          ],
          usage: { input_tokens: 5, output_tokens: 4 },
        }),
      );
    });
  });
  const result = await new OpenAiResponsesAdapter(policy).generate(input);
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([
    { type: 'text', text: 'Stars make light.' },
    { type: 'usage', inputTokens: 5, outputTokens: 4 },
    { type: 'complete', stopReason: 'stop' },
  ]);
  expect(observed).toEqual({
    path: '/v1/responses',
    authorization: 'Bearer secret-key',
    token: 'secret-header',
    body: {
      model: 'reasoner',
      input: [{ role: 'user', content: 'Tell me about stars.' }],
      stream: false,
    },
  });
});

it('delivers Responses deltas before EOF and ignores final text snapshots already delivered', async () => {
  let endResponse: () => void = () => {};
  let firstDelta: () => void = () => {};
  const seen = new Promise<void>((resolve) => {
    firstDelta = resolve;
  });
  const input = await mock((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Stars "}\n\n',
    );
    endResponse = () =>
      response.end(
        'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"shine."}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Stars shine."}]}],"usage":{"input_tokens":2,"output_tokens":3}}}\n\n',
      );
  });
  let complete = false;
  const running = new OpenAiResponsesAdapter(policy, { timeoutMs: 300 })
    .generate({ ...input, stream: true }, undefined, (event) => {
      if (event.type === 'text') firstDelta();
    })
    .then((result) => {
      complete = true;
      return result;
    });
  const beforeEof = await Promise.race([seen.then(() => true), running.then(() => false)]);
  expect(beforeEof).toBe(true);
  expect(complete).toBe(false);
  endResponse();
  expect((await running).events).toEqual([
    { type: 'text', text: 'Stars ' },
    { type: 'text', text: 'shine.' },
    { type: 'usage', inputTokens: 2, outputTokens: 3 },
    { type: 'complete', stopReason: 'stop' },
  ]);
});

it('normalizes interleaved function calls exactly once with complete JSON arguments', async () => {
  const first = {
    type: 'function_call',
    id: 'item-a',
    call_id: 'call-a',
    name: 'assign',
    arguments: '{"owner":"Ada"}',
  };
  const second = {
    type: 'function_call',
    id: 'item-b',
    call_id: 'call-b',
    name: 'schedule',
    arguments: '{"day":3}',
  };
  const frames = [
    { type: 'response.output_item.added', output_index: 0, item: { ...first, arguments: '' } },
    { type: 'response.output_item.added', output_index: 1, item: { ...second, arguments: '' } },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'item-b',
      delta: '{"day":',
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'item-a',
      delta: '{"owner":"Ada"}',
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'item-b',
      delta: '3}',
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      item_id: 'item-a',
      arguments: first.arguments,
    },
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.output_item.done', output_index: 1, item: second },
    { type: 'response.completed', response: { status: 'completed', output: [first, second] } },
  ];
  let body: Record<string, unknown> = {};
  const input = await mock((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      body = JSON.parse(raw);
      response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    });
  });
  const result = await new OpenAiResponsesAdapter(policy).generate({
    ...input,
    stream: true,
    tools: [
      { name: 'assign', parameters: { type: 'object' } },
      { name: 'schedule', parameters: { type: 'object' } },
    ],
    toolChoice: 'assign',
    maxOutputTokens: 512,
  });
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([
    { type: 'action', id: 'call-a', name: 'assign', arguments: { owner: 'Ada' } },
    { type: 'action', id: 'call-b', name: 'schedule', arguments: { day: 3 } },
    { type: 'complete', stopReason: 'tool_calls' },
  ]);
  expect(body).toMatchObject({
    tools: [
      { type: 'function', name: 'assign', parameters: { type: 'object' } },
      { type: 'function', name: 'schedule', parameters: { type: 'object' } },
    ],
    tool_choice: { type: 'function', name: 'assign' },
    max_output_tokens: 512,
  });
});

it.each([
  ['rate_limit_exceeded', 'provider_rate_limited', 'retryable'],
  ['server_error', 'provider_unavailable', 'retryable'],
  ['unsupported_parameter', 'provider_action_unsupported', 'unsupported_capability'],
  ['invalid_api_key', 'provider_authentication_failed', 'non_retryable'],
])(
  'classifies streamed %s errors without returning request secrets',
  async (code, expected, category) => {
    const input = await mock((_request, response) =>
      response.end(
        `data: ${JSON.stringify({ type: 'error', code, param: 'tools', message: 'secret-key secret-header' })}\n\n`,
      ),
    );
    const result = await new OpenAiResponsesAdapter(policy).generate({ ...input, stream: true });
    expect(result.error).toEqual({ code: expected, category });
    expect(JSON.stringify(result)).not.toMatch(/secret-key|secret-header/u);
    expect(result.events).not.toContainEqual(expect.objectContaining({ type: 'complete' }));
  },
);

it.each([
  [429, 'provider_rate_limited', 'retryable'],
  [503, 'provider_unavailable', 'retryable'],
  [401, 'provider_authentication_failed', 'non_retryable'],
  [302, 'provider_request_failed', 'non_retryable'],
])('normalizes HTTP %s safely', async (status, code, category) => {
  const input = await mock((_request, response) => {
    response.writeHead(status, { location: 'http://169.254.169.254/latest' });
    response.end('secret-key secret-header');
  });
  const result = await new OpenAiResponsesAdapter(policy).generate(input);
  expect(result.error).toEqual({ code, category });
  expect(result.raw).not.toMatch(/secret-key|secret-header/u);
});

it('cancels active streamed generation, including while an event consumer is waiting', async () => {
  const input = await mock((_request, response) =>
    response.write(
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}\n\n',
    ),
  );
  const controller = new AbortController();
  const result = await new OpenAiResponsesAdapter(policy).generate(
    { ...input, stream: true },
    controller.signal,
    () => {
      controller.abort();
      return new Promise<void>(() => {});
    },
  );
  expect(result.error).toEqual({ code: 'provider_cancelled', category: 'non_retryable' });
  expect(result.events).toEqual([{ type: 'text', text: 'Hello' }]);
});

it('bounds timeout, stalled DNS and oversized responses while retaining safe partial evidence', async () => {
  const input = await mock((_request, response) =>
    response.write(
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial"}\n\n',
    ),
  );
  const result = await new OpenAiResponsesAdapter(policy, { timeoutMs: 30 }).generate({
    ...input,
    stream: true,
  });
  expect(result.error?.code).toBe('provider_timeout');
  expect(result.raw).toContain('partial');
  const slowPolicy = new ProviderUrlPolicy(
    { hosts: ['slow.example'], schemes: ['https'], privateCidrs: [] },
    () => new Promise(() => {}),
  );
  expect(
    (
      await new OpenAiResponsesAdapter(slowPolicy, { timeoutMs: 20 }).generate({
        ...input,
        baseUrl: 'https://slow.example/v1',
      })
    ).error?.code,
  ).toBe('provider_timeout');
  const large = await mock((_request, response) => response.end('x'.repeat(8 * 1024 * 1024 + 1)));
  expect((await new OpenAiResponsesAdapter(policy).generate(large)).error?.code).toBe(
    'provider_response_too_large',
  );
});

it.each([
  'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial"}\n\n',
  'data: {"type":"response.incomplete"}\n\n',
])('requires a successful terminal event', async (raw) => {
  const input = await mock((_request, response) => response.end(raw));
  expect(
    (await new OpenAiResponsesAdapter(policy).generate({ ...input, stream: true })).error?.code,
  ).toBe('provider_interrupted_stream');
});

it('normalizes plain Chat text and actions through the same model-event contract', async () => {
  const input = await mock((_request, response) =>
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'I assigned it.',
              tool_calls: [
                {
                  id: 'call-42',
                  type: 'function',
                  function: { name: 'assign', arguments: '{"owner":"Ada"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4 },
      }),
    ),
  );
  const result = await new OpenAiChatAdapter(policy).generate(input);
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([
    { type: 'text', text: 'I assigned it.' },
    { type: 'action', id: 'call-42', name: 'assign', arguments: { owner: 'Ada' } },
    { type: 'usage', inputTokens: 5, outputTokens: 4 },
    { type: 'complete', stopReason: 'tool_calls' },
  ]);
});

it('streams Chat text and interleaved actions using the shared live consumer', async () => {
  const frames = [
    {
      choices: [
        {
          delta: {
            content: 'Working.',
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'assign', arguments: '{"owner":' },
              },
              {
                index: 1,
                id: 'call-2',
                type: 'function',
                function: { name: 'schedule', arguments: '{"day":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: '3}' } },
              { index: 0, function: { arguments: '"Ada"}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const input = await mock((_request, response) =>
    response.end(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    ),
  );
  const result = await new OpenAiChatAdapter(policy).generate({ ...input, stream: true });
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([
    { type: 'text', text: 'Working.' },
    { type: 'action', id: 'call-1', name: 'assign', arguments: { owner: 'Ada' } },
    { type: 'action', id: 'call-2', name: 'schedule', arguments: { day: 3 } },
    { type: 'complete', stopReason: 'tool_calls' },
  ]);
});

it('tests Responses text and action capability through the selected adapter', async () => {
  const { ModelConnectionProbe } = await import('../../src/providers/model-probe.js');
  const requests: Record<string, unknown>[] = [];
  const input = await mock((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      const payload = JSON.parse(raw);
      requests.push(payload);
      response.end(
        payload.stream
          ? 'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
          : JSON.stringify({
              status: 'completed',
              output: [
                {
                  type: 'function_call',
                  id: 'item-probe',
                  call_id: 'probe',
                  name: 'openbot_probe',
                  arguments: '{"ok":true}',
                },
              ],
            }),
      );
    });
  });
  const report = await new ModelConnectionProbe(new OpenAiResponsesAdapter(policy), {
    clock: () => new Date('2030-01-02T00:00:00Z'),
  }).run(input);
  expect(report).toMatchObject({
    testedAt: '2030-01-02T00:00:00.000Z',
    text: { ok: true, code: 'passed' },
    action: { ok: true, code: 'passed' },
  });
  expect(requests[1]).toMatchObject({ tool_choice: { type: 'function', name: 'openbot_probe' } });
});

it('dispatches explicit Responses and keeps unsupported action connections text-compatible', async () => {
  const { ProtocolConnectionProbe } = await import('../../src/providers/protocols.js');
  const paths: string[] = [];
  const input = await mock((request, response) => {
    paths.push(request.url ?? '');
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      if (JSON.parse(raw).stream)
        response.end(
          'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        );
      else {
        response.writeHead(400);
        response.end(
          JSON.stringify({
            error: {
              code: 'unsupported_parameter',
              param: 'tools',
              message: 'secret-key secret-header',
            },
          }),
        );
      }
    });
  });
  const report = await new ProtocolConnectionProbe(policy).run({
    ...input,
    protocol: 'openai-responses',
  });
  expect(paths).toEqual(['/v1/responses', '/v1/responses']);
  expect(report.text.ok).toBe(true);
  expect(report.action).toMatchObject({ ok: false, code: 'provider_action_unsupported' });
  expect(JSON.stringify(report)).not.toMatch(/secret-key|secret-header/u);
});

it('preserves split UTF-8 and SSE frames and tolerates unrelated typed events', async () => {
  const raw =
    'event: ping\r\ndata: {"type":"ping"}\r\n\r\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello 星"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\r\n\r\n';
  const bytes = Buffer.from(raw);
  const split = bytes.indexOf(Buffer.from('星')) + 1;
  const input = await mock((_request, response) => {
    response.write(bytes.subarray(0, split));
    setImmediate(() => response.end(bytes.subarray(split)));
  });
  const result = await new OpenAiResponsesAdapter(policy).generate({ ...input, stream: true });
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([
    { type: 'text', text: 'Hello 星' },
    { type: 'complete', stopReason: 'stop' },
  ]);
});

it('rejects malformed function arguments rather than emitting a partial action', async () => {
  const input = await mock((_request, response) =>
    response.end(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'item',
            call_id: 'call',
            name: 'assign',
            arguments: '{"owner":',
          },
        ],
      }),
    ),
  );
  const result = await new OpenAiResponsesAdapter(policy).generate(input);
  expect(result.error).toEqual({ code: 'provider_invalid_response', category: 'non_retryable' });
  expect(result.events).toEqual([]);
});

it('retains bounded diagnostics while allowing a legitimate generation stream beyond probe limits', async () => {
  const raw =
    Array.from(
      { length: 500 },
      (_, sequence_number) =>
        `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'message-1', output_index: 0, content_index: 0, sequence_number, delta: 'a' })}\n\n`,
    ).join('') +
    'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
  expect(Buffer.byteLength(raw)).toBeGreaterThan(65_536);
  const input = await mock((_request, response) => response.end(raw));
  const result = await new OpenAiResponsesAdapter(policy).generate({ ...input, stream: true });
  expect(result.error).toBeUndefined();
  expect(result.events.filter((event) => event.type === 'text')).toHaveLength(500);
  expect(result.events.at(-1)).toEqual({ type: 'complete', stopReason: 'stop' });
  expect(Buffer.byteLength(result.raw)).toBeLessThanOrEqual(65_536);
});

it.each(['\r', '\r\n', '\n'])(
  'accepts SSE line endings and ignores trailing comments (%j)',
  async (ending) => {
    const text = `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"ok"}${ending}${ending}`;
    const completion = `data: {"type":"response.completed","response":{"status":"completed","output":[]}}${ending}${ending}`;
    const input = await mock((_request, response) => {
      response.write(text.slice(0, -1));
      setImmediate(() => response.end(text.slice(-1) + completion + ': keepalive' + ending));
    });
    const result = await new OpenAiResponsesAdapter(policy).generate({ ...input, stream: true });
    expect(result.error).toBeUndefined();
    expect(result.events).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'complete', stopReason: 'stop' },
    ]);
  },
);

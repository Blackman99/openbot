import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readConversationStream,
  readConversationStreamBootstrap,
} from '../../src/lib/server/conversation-stream-api.js';
import { GET as eventsRoute } from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/events/+server.js';
import { GET as bootstrapRoute } from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/events/bootstrap/+server.js';
import { ConversationStreamDecoder } from '../../src/lib/conversation-stream-codec.js';
import { encodeConversationStreamCursor } from '../../src/lib/conversation-stream-contract.js';

const scope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
};
const session = 's'.repeat(43);
const cursor = (after: number) => encodeConversationStreamCursor(scope, after);
const encode = (value: string) => new TextEncoder().encode(value);
const snapshot = () => ({
  schemaVersion: 1,
  conversationId: scope.conversationId,
  cursor: cursor(0),
  messages: [],
  nextMessageCursor: null,
  executions: [],
  nextTaskCursor: null,
  previews: [],
  previewsTruncated: false,
});
const frame = (sequence: number) =>
  `id: ${cursor(sequence)}\nevent: conversation.invalidated\ndata: ${JSON.stringify({ schemaVersion: 1, cursor: cursor(sequence), conversationId: scope.conversationId, sequence, occurredAt: '2030-01-01T00:00:00.000Z', type: 'conversation.invalidated', data: { reason: 'membership' } })}\n\n`;
function context(bootstrap = false) {
  const url = `http://localhost:3000/app/workspaces/${scope.workspaceId}/conversations/${scope.conversationId}/events${bootstrap ? '/bootstrap' : ''}`;
  const cookies = {
    get: vi.fn((): string | undefined => session),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(() => ''),
  };
  return {
    params: scope,
    cookies,
    request: new Request(url, { headers: bootstrap ? {} : { 'last-event-id': cursor(0) } }),
    fetch: vi.fn<typeof fetch>(async () => Response.json(snapshot())),
  };
}
function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let count = 0;
  const waits: { count: number; resolve: () => void }[] = [];
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        count++;
        for (const wait of waits) if (count >= wait.count) wait.resolve();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    cancel,
    pulls: () => count,
    push: (value: string | Uint8Array) =>
      controller.enqueue(typeof value === 'string' ? encode(value) : value),
    close: () => controller.close(),
    waitForPull: (expected: number) =>
      count >= expected
        ? Promise.resolve()
        : new Promise<void>((resolve) => waits.push({ count: expected, resolve })),
  };
}
function streaming(ctx: ReturnType<typeof context>, body: ReadableStream<Uint8Array>) {
  ctx.fetch.mockResolvedValueOnce(
    new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'set-cookie': 'evil=value',
        location: 'http://internal/secret',
        'x-private-secret': 'secret',
        'content-length': '999',
      },
    }),
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('private conversation stream BFF', () => {
  it('wires both GET routes to the scoped helpers and forwards only the session to a fixed bootstrap API URL', async () => {
    expect(eventsRoute).toBe(readConversationStream);
    expect(bootstrapRoute).toBe(readConversationStreamBootstrap);
    vi.stubEnv('API_BASE_URL', 'http://private-api:3001/');
    const ctx = context(true);
    ctx.request = new Request(ctx.request.url, {
      headers: {
        authorization: 'Bearer stolen',
        cookie: 'other=secret',
        origin: 'https://untrusted.example',
        'x-api-url': 'https://untrusted.example',
      },
    });
    const response = await readConversationStreamBootstrap(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot());
    expect(ctx.fetch).toHaveBeenCalledOnce();
    const [url, options] = ctx.fetch.mock.calls[0]!;
    expect(url).toBe(
      `http://private-api:3001/api/v1/workspaces/${scope.workspaceId}/conversations/${scope.conversationId}/events/bootstrap`,
    );
    expect(options).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { cookie: `openbot_session=${session}` },
    });
    expect(new Headers(options?.headers).entries().toArray()).toEqual([
      ['cookie', `openbot_session=${session}`],
    ]);
    expect(response.headers.get('cache-control')).toBe('private, no-store, no-transform');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each(['missing', 'duplicate', 'scope', 'query', 'body', 'bootstrap-cursor'])(
    'rejects invalid %s stream requests without forwarding credentials',
    async (kind) => {
      const ctx = context(kind === 'bootstrap-cursor');
      const headers = new Headers(ctx.request.headers);
      if (kind === 'missing') headers.delete('last-event-id');
      if (kind === 'duplicate') headers.append('last-event-id', cursor(1));
      if (kind === 'scope')
        headers.set(
          'last-event-id',
          encodeConversationStreamCursor({ ...scope, workspaceId: scope.conversationId }, 0),
        );
      if (kind === 'body') headers.set('content-length', '1');
      if (kind === 'bootstrap-cursor') headers.set('last-event-id', cursor(0));
      ctx.request = new Request(ctx.request.url + (kind === 'query' ? '?cursor=secret' : ''), {
        headers,
      });
      const response = await (kind === 'bootstrap-cursor'
        ? readConversationStreamBootstrap(ctx)
        : readConversationStream(ctx));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: 'invalid_stream_cursor' } });
      expect(ctx.fetch).not.toHaveBeenCalled();
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    },
  );

  it('returns local 401 for a missing or malformed cookie without claiming an upstream logout', async () => {
    for (const token of [undefined, 'invalid; forged=credential']) {
      const ctx = context(true);
      ctx.cookies.get.mockReturnValue(token);
      const response = await readConversationStreamBootstrap(ctx);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: 'authentication_required' } });
      expect(ctx.fetch).not.toHaveBeenCalled();
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    }
  });

  it.each([
    [400, 'invalid_stream_cursor'],
    [403, 'conversation_forbidden'],
    [410, 'cursor_expired'],
    [503, 'conversation_stream_unavailable'],
  ] as const)('preserves exact safe HTTP %s errors and keeps identity', async (status, code) => {
    const ctx = context();
    ctx.fetch.mockResolvedValueOnce(Response.json({ error: { code } }, { status }));
    const response = await readConversationStream(ctx);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });

  it.each(['extra', 'wrong-code', 'large', 'html', 'redirect'])(
    'maps unsafe %s error responses to a fixed unavailable envelope',
    async (kind) => {
      const ctx = context();
      const response =
        kind === 'redirect'
          ? new Response('secret', { status: 302, headers: { location: 'http://private' } })
          : kind === 'html'
            ? new Response('secret', { status: 403 })
            : kind === 'large'
              ? new Response(' '.repeat(4097), {
                  status: 403,
                  headers: { 'content-type': 'application/json' },
                })
              : Response.json(
                  {
                    error: {
                      code:
                        kind === 'wrong-code'
                          ? 'authentication_required'
                          : 'conversation_forbidden',
                      ...(kind === 'extra' ? { secret: 'private' } : {}),
                    },
                  },
                  { status: 403 },
                );
      ctx.fetch.mockResolvedValueOnce(response);
      const result = await readConversationStream(ctx);
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: { code: 'conversation_stream_unavailable' } });
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
      expect(result.headers.has('location')).toBe(false);
    },
  );

  it('clears the cookie only for an actual upstream HTTP 401', async () => {
    const ctx = context(true);
    ctx.fetch.mockResolvedValueOnce(new Response('private diagnostic', { status: 401 }));
    const response = await readConversationStreamBootstrap(ctx);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'authentication_required' } });
    expect(ctx.cookies.delete).toHaveBeenCalledExactlyOnceWith('openbot_session', { path: '/' });
  });

  it.each(['extra', 'oversized', 'length', 'wrong-type', 'invalid-utf8'])(
    'strictly bounds and validates the %s bootstrap response',
    async (kind) => {
      const ctx = context(true);
      const body =
        kind === 'oversized'
          ? ' '.repeat(1048577)
          : kind === 'invalid-utf8'
            ? new Uint8Array([0xff])
            : JSON.stringify({ ...snapshot(), ...(kind === 'extra' ? { secret: 'private' } : {}) });
      ctx.fetch.mockResolvedValueOnce(
        new Response(body, {
          headers: {
            'content-type': kind === 'wrong-type' ? 'text/plain' : 'application/json',
            ...(kind === 'length' ? { 'content-length': '1' } : {}),
          },
        }),
      );
      const response = await readConversationStreamBootstrap(ctx);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'conversation_stream_unavailable' } });
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    },
  );

  it('forwards the first complete frame before upstream completion and reads only on downstream demand', async () => {
    const ctx = context();
    const upstream = source();
    streaming(ctx, upstream.stream);
    const response = await readConversationStream(ctx);
    expect(response.status).toBe(200);
    expect(upstream.pulls()).toBe(0);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    for (const name of ['set-cookie', 'location', 'x-private-secret', 'content-length'])
      expect(response.headers.has(name)).toBe(false);
    expect(new Headers(ctx.fetch.mock.calls[0]?.[1]?.headers).get('last-event-id')).toBe(cursor(0));
    const reader = response.body!.getReader();
    let settled = false;
    const first = reader.read().then((value) => {
      settled = true;
      return value;
    });
    await upstream.waitForPull(1);
    const bytes = encode(frame(1));
    upstream.push(bytes.subarray(0, bytes.length - 1));
    await upstream.waitForPull(2);
    expect(settled).toBe(false);
    upstream.push(bytes.subarray(bytes.length - 1));
    const received = await first;
    expect(received.done).toBe(false);
    expect(new ConversationStreamDecoder(scope).feed(received.value!)).toMatchObject([
      { kind: 'event', event: { sequence: 1 } },
    ]);
    expect(upstream.cancel).not.toHaveBeenCalled();
    expect(upstream.pulls()).toBe(2);
    await reader.cancel();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(ctx.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(ctx.fetch).toHaveBeenCalledOnce();
  });

  it('drains a bounded multi-frame chunk before another upstream read', async () => {
    const ctx = context();
    const upstream = source();
    streaming(ctx, upstream.stream);
    const response = await readConversationStream(ctx);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = reader.read();
    await upstream.waitForPull(1);
    upstream.push(frame(1) + frame(2));
    expect(new ConversationStreamDecoder(scope).feed((await first).value!)).toMatchObject([
      { kind: 'event', event: { sequence: 1 } },
    ]);
    const second = await reader.read();
    expect(new ConversationStreamDecoder(scope).feed(second.value!)).toMatchObject([
      { kind: 'event', event: { sequence: 2 } },
    ]);
    expect(upstream.pulls()).toBe(1);
    await reader.cancel();
  });

  it('bounds combined queued frames when an earlier partial frame completes in a full transport chunk', async () => {
    const ctx = context();
    const upstream = source();
    streaming(ctx, upstream.stream);
    const response = await readConversationStream(ctx);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const pending = reader.read();
    const text = frame(1);
    const bytes = encode(text);
    await upstream.waitForPull(1);
    upstream.push(bytes.subarray(0, bytes.length - 1));
    await upstream.waitForPull(2);
    const batch = '\n' + text.repeat(Math.floor((524288 - 1) / bytes.length));
    expect(encode(batch).byteLength).toBeLessThanOrEqual(524288);
    expect(encode(batch).byteLength + bytes.length - 1).toBeGreaterThan(524288);
    upstream.push(batch);
    expect(new ConversationStreamDecoder(scope).feed((await pending).value!)).toEqual([
      { kind: 'control', code: 'conversation_stream_unavailable' },
    ]);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it.each([0, 15000])(
    'replaces upstream activity at %i ms with a data-free heartbeat and no cursor',
    async (elapsed) => {
      vi.useFakeTimers();
      const ctx = context();
      const upstream = source();
      streaming(ctx, upstream.stream);
      const response = await readConversationStream(ctx);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const pending = reader.read();
      await upstream.waitForPull(1);
      await vi.advanceTimersByTimeAsync(elapsed);
      upstream.push(': private upstream diagnostic\n\n');
      const result = await pending;
      expect(new TextDecoder().decode(result.value)).toBe(': heartbeat\n\n');
      expect(new ConversationStreamDecoder(scope).feed(result.value!)).toEqual([]);
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
      await reader.cancel();
    },
  );

  it('closes a consumer with no demand after 10 seconds without another pull', async () => {
    vi.useFakeTimers();
    const ctx = context();
    const upstream = source();
    streaming(ctx, upstream.stream);
    const response = await readConversationStream(ctx);
    expect(response.status).toBe(200);
    await vi.advanceTimersByTimeAsync(9999);
    expect(upstream.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.pulls()).toBe(0);
    expect(await response.body!.getReader().read()).toEqual({ done: true, value: undefined });
  });

  it('propagates navigation abort into the active reader and request without any Task call', async () => {
    const ctx = context();
    const upstream = source();
    streaming(ctx, upstream.stream);
    const navigation = new AbortController();
    ctx.request = new Request(ctx.request, { signal: navigation.signal });
    const response = await readConversationStream(ctx);
    expect(response.status).toBe(200);
    const pending = response.body!.getReader().read();
    await upstream.waitForPull(1);
    navigation.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(ctx.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(ctx.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v1/workspaces/${scope.workspaceId}/conversations/${scope.conversationId}/events`,
    ]);
  });

  it('forwards a content-free control 401 without clearing the cookie', async () => {
    const ctx = context();
    const upstream = source();
    streaming(ctx, upstream.stream);
    const response = await readConversationStream(ctx);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const pending = reader.read();
    await upstream.waitForPull(1);
    upstream.push(
      'event: stream.control\ndata: {"schemaVersion":1,"code":"authentication_required"}\n\n',
    );
    expect(new ConversationStreamDecoder(scope).feed((await pending).value!)).toEqual([
      { kind: 'control', code: 'authentication_required' },
    ]);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });

  it('rejects an empty transport chunk before consuming another frame', async () => {
    const ctx = context();
    const upstream = source();
    streaming(ctx, upstream.stream);
    const response = await readConversationStream(ctx);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const pending = reader.read();
    await upstream.waitForPull(1);
    upstream.push(new Uint8Array());
    upstream.push(frame(1));
    expect(new ConversationStreamDecoder(scope).feed((await pending).value!)).toEqual([
      { kind: 'control', code: 'conversation_stream_unavailable' },
    ]);
    await reader.cancel();
  });

  it.each(['malformed', 'truncated', 'oversized'])(
    'closes %s frames without forwarding raw diagnostics or a durable id',
    async (kind) => {
      const ctx = context();
      const upstream = source();
      streaming(ctx, upstream.stream);
      const response = await readConversationStream(ctx);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const pending = reader.read();
      await upstream.waitForPull(1);
      upstream.push(
        kind === 'oversized'
          ? new Uint8Array(524289)
          : kind === 'truncated'
            ? 'id: private'
            : 'id: private\nevent: secret\ndata: {"rawSecret":"private"}\n\n',
      );
      if (kind === 'truncated') upstream.close();
      const result = await pending;
      expect(new TextDecoder().decode(result.value)).not.toContain('private');
      expect(new ConversationStreamDecoder(scope).feed(result.value!)).toMatchObject([
        { kind: 'control' },
      ]);
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    },
  );

  it.each(['connect', 'bootstrap', 'error', 'idle'])(
    'bounds a stalled upstream %s read separately from downstream drain',
    async (mode) => {
      vi.useFakeTimers();
      const ctx = context(mode === 'bootstrap');
      const upstream = source();
      if (mode === 'connect')
        ctx.fetch.mockImplementationOnce(() => new Promise<Response>(() => {}));
      else
        ctx.fetch.mockResolvedValueOnce(
          new Response(upstream.stream, {
            status: mode === 'error' ? 403 : 200,
            headers: { 'content-type': mode === 'idle' ? 'text/event-stream' : 'application/json' },
          }),
        );
      const pending =
        mode === 'bootstrap' ? readConversationStreamBootstrap(ctx) : readConversationStream(ctx);
      if (mode === 'idle') {
        const response = await pending;
        expect(response.status).toBe(200);
        const read = response.body!.getReader().read();
        await upstream.waitForPull(1);
        await vi.advanceTimersByTimeAsync(30000);
        const result = await read;
        expect(
          result.done ||
            new ConversationStreamDecoder(scope)
              .feed(result.value!)
              .every((item) => item.kind === 'control'),
        ).toBe(true);
      } else {
        if (mode !== 'connect') await upstream.waitForPull(1);
        await vi.advanceTimersByTimeAsync(30000);
        expect((await pending).status).toBe(503);
      }
      expect(ctx.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    },
  );
});

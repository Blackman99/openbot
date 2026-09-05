import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConversationStreamMessage } from '../../src/lib/server/conversation-stream-api.js';
import { GET } from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/events/messages/[messageId]/+server.js';
import { conversation, message, page, token, workspace } from '../fixtures/conversations.js';

function context() {
  return {
    params: { workspaceId: workspace.id, conversationId: conversation.id, messageId: message.id },
    cookies: {
      get: vi.fn((): string | undefined => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(() => ''),
    },
    request: new Request(
      `http://localhost:3000/app/workspaces/${workspace.id}/conversations/${conversation.id}/events/messages/${message.id}`,
    ),
    fetch: vi.fn<typeof fetch>(async () => Response.json(page)),
  };
}
afterEach(() => vi.useRealTimers());
describe('stream current-message JSON locator', () => {
  it('uses the existing current projection parser and targets exactly one fixed message locator', async () => {
    expect(GET).toBe(readConversationStreamMessage);
    const ctx = context();
    ctx.request = new Request(ctx.request.url, {
      headers: {
        authorization: 'Bearer private',
        cookie: 'other=secret',
        origin: 'https://untrusted.example',
      },
    });
    const response = await readConversationStreamMessage(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message });
    expect(ctx.fetch).toHaveBeenCalledOnce();
    const [url, options] = ctx.fetch.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe('http://localhost:3001');
    expect(parsed.pathname).toBe(
      `/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}`,
    );
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ messageId: message.id, limit: '1' });
    expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(Array.from(new Headers(options?.headers))).toEqual([
      ['cookie', `openbot_session=${token}`],
    ]);
    expect(response.headers.get('cache-control')).toBe('private, no-store, no-transform');
  });

  it.each(['wrong-message', 'malformed-projection', 'oversized', 'extra', 'wrong-type'])(
    'rejects a %s response instead of returning unvalidated source metadata',
    async (kind) => {
      const ctx = context();
      const value = {
        ...page,
        ...(kind === 'extra' ? { private: 'secret' } : {}),
        messages: [
          {
            ...message,
            ...(kind === 'wrong-message'
              ? { id: conversation.id }
              : kind === 'malformed-projection'
                ? { attachments: [{ private: 'secret' }] }
                : {}),
          },
        ],
      };
      ctx.fetch.mockResolvedValueOnce(
        new Response(kind === 'oversized' ? ' '.repeat(1048577) : JSON.stringify(value), {
          headers: { 'content-type': kind === 'wrong-type' ? 'text/html' : 'application/json' },
        }),
      );
      const response = await readConversationStreamMessage(ctx);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'conversation_stream_unavailable' } });
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    },
  );

  it('returns a current tombstone without a captured body', async () => {
    const ctx = context();
    const deleted = {
      ...message,
      deleted: true,
      body: null,
      reason: 'Removed',
      canEdit: false,
      canDelete: false,
    };
    ctx.fetch.mockResolvedValueOnce(Response.json({ ...page, messages: [deleted] }));
    const response = await readConversationStreamMessage(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: deleted });
  });

  it('rejects invalid UTF-8 inside an otherwise valid current message body', async () => {
    const ctx = context();
    const raw = JSON.stringify(page);
    const bytes = new TextEncoder().encode(raw);
    bytes[new TextEncoder().encode(raw.slice(0, raw.indexOf('First message'))).byteLength] = 255;
    ctx.fetch.mockResolvedValueOnce(
      new Response(bytes, { headers: { 'content-type': 'application/json' } }),
    );
    const response = await readConversationStreamMessage(ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'conversation_stream_unavailable' } });
  });

  it.each([401, 403, 503])(
    'maps actual locator HTTP %s without treating forbidden or unavailable as logout',
    async (status) => {
      const ctx = context();
      ctx.fetch.mockResolvedValueOnce(
        Response.json(
          {
            error: { code: status === 403 ? 'conversation_forbidden' : 'authentication_required' },
          },
          { status },
        ),
      );
      const response = await readConversationStreamMessage(ctx);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: {
          code:
            status === 401
              ? 'authentication_required'
              : status === 403
                ? 'conversation_forbidden'
                : 'conversation_stream_unavailable',
        },
      });
      expect(ctx.cookies.delete).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    },
  );

  it('rejects missing identity, invalid IDs, queries and pre-aborted navigation without upstream work', async () => {
    for (const kind of ['anonymous', 'id', 'query', 'abort']) {
      const ctx = context();
      if (kind === 'anonymous') ctx.cookies.get.mockReturnValue(undefined);
      if (kind === 'id') ctx.params.messageId = '../secret';
      if (kind === 'query') ctx.request = new Request(ctx.request.url + '?url=http://private');
      if (kind === 'abort') ctx.request = new Request(ctx.request, { signal: AbortSignal.abort() });
      const response = await readConversationStreamMessage(ctx);
      expect(response.status).toBe(kind === 'anonymous' ? 401 : kind === 'abort' ? 503 : 400);
      expect(ctx.fetch).not.toHaveBeenCalled();
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    }
  });

  it('cancels a pending current-source response on navigation and preserves identity', async () => {
    const ctx = context();
    const navigation = new AbortController();
    ctx.request = new Request(ctx.request, { signal: navigation.signal });
    let read!: () => void;
    const started = new Promise<void>((resolve) => {
      read = resolve;
    });
    const cancel = vi.fn();
    ctx.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              read();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const pending = readConversationStreamMessage(ctx);
    await started;
    navigation.abort();
    expect((await pending).status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
    expect(ctx.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });
});

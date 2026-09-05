import { describe, expect, it, vi } from 'vitest';
import {
  conversationAction,
  loadConversationPage,
  loadConversationsPage,
  loadMessageVersionsPage,
} from '../../src/lib/server/conversation-page.js';
import {
  bot,
  conversation,
  message,
  page,
  receipt,
  token,
  user,
  version,
  workspace,
} from '../fixtures/conversations.js';
const group = {
  id: conversation.subject.id,
  workspaceId: workspace.id,
  name: 'Research group',
  description: '',
  visibility: 'private',
  role: 'member',
  createdAt: conversation.createdAt,
  updatedAt: conversation.createdAt,
};
function context(lifecycleState: 'active' | 'archived' = 'active') {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith('/groups'))
      return Response.json({
        groups: [
          group,
          {
            ...group,
            id: message.id,
            name: 'Discovery group',
            visibility: 'workspace',
            role: null,
          },
        ],
      });
    if (path.endsWith('/bots')) {
      const { currentVersion: _version, ...summary } = bot;
      return Response.json({
        bots: [
          {
            ...summary,
            lifecycleState,
            bindingStatus: { state: 'unavailable', reason: 'disabled' },
          },
          {
            ...summary,
            id: message.id,
            name: 'Discovery Bot',
            visibility: 'workspace',
            accessRole: null,
          },
        ],
      });
    }
    if (path.endsWith('/versions')) return Response.json({ versions: [version] });
    if (path.endsWith(`/conversations/${conversation.id}`)) return Response.json(page);
    throw new Error(`Unexpected API path ${path}`);
  });
  return {
    fetch,
    cookies: {
      get: vi.fn(() => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
    setHeaders: vi.fn(),
    url: new URL(
      `http://localhost:3000/app/workspaces/${workspace.id}/conversations/${conversation.id}`,
    ),
  };
}
describe('Conversation page boundary', () => {
  it('forwards an exact message locator so the response can be opened beyond the first page', async () => {
    const event = context();
    event.url.searchParams.set('messageId', message.id.toUpperCase());
    const result = await loadConversationPage(event, workspace.id, conversation.id);
    expect(result.messages).toEqual(page.messages);
    expect(new URL(String(event.fetch.mock.calls.at(-1)?.[0])).searchParams.get('messageId')).toBe(
      message.id,
    );
  });

  it.each([
    `messageId=${message.id}&cursor=opaque_cursor`,
    'messageId=not-a-uuid',
    `messageId=${message.id}&messageId=${message.id}`,
  ])('rejects ambiguous or malformed locator %s', async (query) => {
    const event = context();
    event.url.search = '?' + query;
    await expect(loadConversationPage(event, workspace.id, conversation.id)).rejects.toMatchObject({
      status: 400,
    });
    expect(event.fetch.mock.calls.some(([url]) => String(url).includes('/conversations/'))).toBe(
      false,
    );
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });

  it('excludes archived Bots from new conversation choices', async () => {
    expect((await loadConversationsPage(context('archived'), workspace.id)).subjects).toEqual([
      { kind: 'group', id: group.id, name: group.name },
    ]);
  });
  it('offers explicit group/Bot access, including unavailable models, without opening a thread on GET', async () => {
    const event = context();
    expect(await loadConversationsPage(event, workspace.id.toUpperCase())).toMatchObject({
      subjects: [
        { kind: 'group', id: group.id, name: group.name },
        { kind: 'direct-bot', id: bot.id, name: bot.name },
      ],
    });
    expect(event.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
    expect(event.fetch.mock.calls.some(([url]) => String(url).includes('model-connections'))).toBe(
      false,
    );
  });
  it('loads current projections with separate command keys without preloading private versions', async () => {
    const event = context();
    event.url.searchParams.set('cursor', 'opaque_cursor-1');
    const result = await loadConversationPage(event, workspace.id, conversation.id);
    expect(result).toMatchObject({
      ...page,
      commands: {
        append: expect.any(String),
        messages: { [message.id]: { edit: expect.any(String), tombstone: expect.any(String) } },
      },
    });
    expect(event.fetch.mock.calls.some(([url]) => String(url).includes('/versions'))).toBe(false);
    expect(new URL(String(event.fetch.mock.calls.at(-1)?.[0])).searchParams.get('cursor')).toBe(
      'opaque_cursor-1',
    );
  });
  it('opens through POST only, then redirects to the canonical private/group thread', async () => {
    const event = context();
    event.fetch.mockResolvedValueOnce(Response.json({ conversation }));
    const request = new Request('http://localhost:3000/conversations', {
      method: 'POST',
      body: new URLSearchParams({ kind: 'group', subjectId: group.id.toUpperCase() }),
    });
    await expect(
      conversationAction({ ...event, request }, workspace.id.toUpperCase(), undefined, 'open'),
    ).rejects.toMatchObject({
      status: 303,
      location: `/app/workspaces/${workspace.id}/conversations/${conversation.id}`,
    });
    expect(event.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ subject: conversation.subject }),
    });
  });
  it.each(['append', 'edit', 'tombstone'] as const)(
    'preserves the complete %s command through an ambiguous failure and retries the same key',
    async (action) => {
      const event = context();
      const values = {
        idempotencyKey: 'stable-command-key',
        ...(action === 'tombstone' ? { reason: 'A reason' } : { body: 'Draft\n  stays' }),
        ...(action === 'append' ? {} : { messageId: message.id, expectedVersion: '1' }),
      };
      const request = () =>
        new Request('http://localhost:3000/conversations', {
          method: 'POST',
          body: new URLSearchParams(values),
        });
      event.fetch
        .mockResolvedValueOnce(
          Response.json({ error: { code: 'conversation_unavailable' } }, { status: 503 }),
        )
        .mockResolvedValueOnce(Response.json({ receipt }));
      expect(
        await conversationAction(
          { ...event, request: request() },
          workspace.id,
          conversation.id,
          action,
        ),
      ).toMatchObject({ status: 503, data: { action, values } });
      await expect(
        conversationAction({ ...event, request: request() }, workspace.id, conversation.id, action),
      ).rejects.toMatchObject({ status: 303 });
      expect(event.fetch.mock.calls[0]?.[1]?.body).toBe(event.fetch.mock.calls[1]?.[1]?.body);
      expect(event.cookies.delete).not.toHaveBeenCalled();
    },
  );
  it('keeps the stale edit precondition and draft on a version conflict instead of silently overwriting', async () => {
    const event = context();
    event.fetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'message_version_conflict' } }, { status: 409 }),
    );
    const values = {
      messageId: message.id,
      expectedVersion: '1',
      idempotencyKey: 'edit-once',
      body: 'Keep my draft',
    };
    const request = new Request('http://localhost:3000/conversations', {
      method: 'POST',
      body: new URLSearchParams(values),
    });
    expect(
      await conversationAction({ ...event, request }, workspace.id, conversation.id, 'edit'),
    ).toMatchObject({
      status: 409,
      data: {
        action: 'edit',
        values,
        conflict: true,
        error: expect.stringContaining('latest version'),
      },
    });
  });
  it('reads message versions only through the separately authorized endpoint', async () => {
    const event = context();
    expect(
      await loadMessageVersionsPage(event, workspace.id, conversation.id, message.id),
    ).toMatchObject({
      versions: [version],
      conversationId: conversation.id,
      messageId: message.id,
    });
    expect(event.fetch.mock.calls.at(-1)?.[0]).toBe(
      `http://localhost:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/messages/${message.id}/versions`,
    );
  });
  it.each(['current', 'versions'] as const)(
    'denies a revoked %s read without clearing a valid identity cookie',
    async (kind) => {
      const event = context();
      event.fetch
        .mockResolvedValueOnce(Response.json({ user, workspace: null }))
        .mockResolvedValueOnce(Response.json({ workspaces: [workspace] }))
        .mockResolvedValueOnce(
          Response.json({ error: { code: 'conversation_forbidden' } }, { status: 403 }),
        );
      await expect(
        kind === 'current'
          ? loadConversationPage(event, workspace.id, conversation.id)
          : loadMessageVersionsPage(event, workspace.id, conversation.id, message.id),
      ).rejects.toMatchObject({ status: 403 });
      expect(event.cookies.delete).not.toHaveBeenCalled();
      expect(event.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
    },
  );
  it.each([401, 403, 500])('treats HTTP %s as authoritative on a failed write', async (status) => {
    const event = context();
    event.fetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: status === 403 ? 'conversation_forbidden' : 'authentication_required',
            ...(status === 500 ? { message: 'private diagnostics' } : {}),
          },
        },
        { status },
      ),
    );
    const request = new Request(event.url, {
      method: 'POST',
      body: new URLSearchParams({ idempotencyKey: 'write-key', body: 'My draft' }),
    });
    const result = conversationAction(
      { ...event, request },
      workspace.id,
      conversation.id,
      'append',
    );
    if (status === 401) {
      await expect(result).rejects.toMatchObject({ status: 303, location: '/sign-in' });
      expect(event.cookies.delete).toHaveBeenCalled();
    } else {
      const failure = await result;
      expect(failure).toMatchObject({
        status: status === 403 ? 403 : 503,
        data: { values: { body: 'My draft' } },
      });
      expect(JSON.stringify(failure)).not.toContain('private diagnostics');
      expect(event.cookies.delete).not.toHaveBeenCalled();
    }
  });
  it('rejects forged actor fields and duplicate command fields before calling the API', async () => {
    for (const extra of [
      ['actorUserId', user.id],
      ['body', 'second body'],
    ]) {
      const event = context();
      const fields = new URLSearchParams({ idempotencyKey: 'write-key', body: 'My draft' });
      fields.append(extra[0]!, extra[1]!);
      const request = new Request(event.url, { method: 'POST', body: fields });
      expect(
        await conversationAction({ ...event, request }, workspace.id, conversation.id, 'append'),
      ).toMatchObject({ status: 400 });
      expect(event.fetch).not.toHaveBeenCalled();
    }
  });
  it('rejects duplicate cursors and starts new command identities on an explicit fresh page', async () => {
    const event = context();
    const first = await loadConversationPage(event, workspace.id, conversation.id);
    const next = await loadConversationPage(event, workspace.id, conversation.id);
    expect(
      new Set([
        first.commands.append,
        next.commands.append,
        first.commands.messages[message.id]?.edit,
        first.commands.messages[message.id]?.tombstone,
      ]).size,
    ).toBe(4);
    event.url.search = '?cursor=one&cursor=two';
    await expect(loadConversationPage(event, workspace.id, conversation.id)).rejects.toMatchObject({
      status: 400,
    });
  });
});

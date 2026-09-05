import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { ConversationApiClient } from '../../src/lib/server/conversation-api.js';
import {
  conversation,
  message,
  page,
  receipt,
  token,
  version,
  workspace,
} from '../fixtures/conversations.js';
describe('Conversation API client', () => {
  it('reads a canonical scoped page with opaque pagination and no body-only HTTP headers', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(page));
    const client = new ConversationApiClient(request, 'http://api:3001/', 'http://localhost:3000');
    expect(
      await client.get(token, workspace.id.toUpperCase(), conversation.id.toUpperCase(), {
        cursor: 'opaque_cursor-1',
        limit: 30,
      }),
    ).toEqual({ status: 'available', value: page });
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}?cursor=opaque_cursor-1&limit=30`,
    );
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('content-type');
  });
  it('opens the exact subject and preserves immutable command payloads and receipts across all mutations', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ conversation }))
      .mockResolvedValueOnce(Response.json({ receipt }))
      .mockResolvedValueOnce(Response.json({ receipt }))
      .mockResolvedValueOnce(Response.json({ receipt }));
    const client = new ConversationApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.open(token, workspace.id, conversation.subject)).toEqual({
      status: 'available',
      value: conversation,
    });
    expect(
      await client.append(token, workspace.id, conversation.id, {
        idempotencyKey: 'stable-key',
        body: message.body,
      }),
    ).toEqual({ status: 'available', value: receipt });
    expect(
      await client.edit(token, workspace.id, conversation.id, message.id.toUpperCase(), {
        idempotencyKey: 'edit-key',
        expectedVersion: 1,
        body: 'Edited',
      }),
    ).toEqual({ status: 'available', value: receipt });
    expect(
      await client.tombstone(token, workspace.id, conversation.id, message.id, {
        idempotencyKey: 'delete-key',
        expectedVersion: 2,
        reason: 'Moderated',
      }),
    ).toEqual({ status: 'available', value: receipt });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ subject: conversation.subject }),
      headers: { 'content-type': 'application/json' },
    });
    expect(request.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ idempotencyKey: 'stable-key', body: message.body }),
    );
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ idempotencyKey: 'edit-key', expectedVersion: 1, body: 'Edited' }),
    });
    expect(request.mock.calls[3]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/messages/${message.id}/tombstone`,
    );
  });
  it('reads an explicitly authorized immutable version chain separately', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ versions: [version] }));
    const client = new ConversationApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.versions(token, workspace.id, conversation.id, message.id)).toEqual({
      status: 'available',
      value: [version],
    });
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('content-type');
  });
  it.each([
    [401, 'authentication_required', 'anonymous'],
    [403, 'conversation_forbidden', 'forbidden'],
    [403, 'invalid_origin', 'forbidden'],
    [400, 'invalid_conversation_request', 'invalid'],
    [409, 'idempotency_conflict', 'idempotency-conflict'],
    [409, 'message_version_conflict', 'version-conflict'],
    [500, 'authentication_required', 'unavailable'],
    [403, 'authentication_required', 'unavailable'],
  ])(
    'matches status %i and error %s without trusting upstream diagnostics',
    async (status, code, expected) => {
      const client = new ConversationApiClient(
        vi.fn(async () => Response.json({ error: { code } }, { status })),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.get(token, workspace.id, conversation.id)).toEqual({ status: expected });
    },
  );
  it('rejects malformed scope, private upstream fields, invalid ordering and unsafe tombstone projections', async () => {
    for (const value of [
      { ...page, conversation: { ...conversation, workspaceId: message.id } },
      { ...page, conversation: { ...conversation, instructions: 'secret' } },
      { ...page, nextCursor: '../private' },
      { ...page, nextCursor: 'x'.repeat(513) },
      { ...page, messages: [message, message] },
      { ...page, messages: [{ ...message, author: { ...message.author, email: 'private' } }] },
      { ...page, messages: [{ ...message, sequence: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...page, messages: [{ ...message, createdAt: '2026-02-31T00:00:00.000Z' }] },
      { ...page, messages: [{ ...message, deleted: true, reason: 'Removed' }] },
      { ...page, messages: [{ ...message, deleted: true, body: null, reason: 'Removed' }] },
      {
        ...page,
        messages: [
          { ...message, deleted: true, body: null, reason: null, canEdit: false, canDelete: false },
        ],
      },
      { ...page, messages: [{ ...message, reason: 'Unexpected reason' }] },
    ]) {
      const client = new ConversationApiClient(
        vi.fn(async () => Response.json(value)),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.get(token, workspace.id, conversation.id)).toEqual({
        status: 'unavailable',
      });
    }
    const deleted = {
      ...message,
      sequence: 2,
      version: 2,
      deleted: true,
      body: null,
      reason: 'Removed',
      canEdit: false,
      canDelete: false,
    };
    const client = new ConversationApiClient(
      vi.fn(async () => Response.json({ ...page, messages: [deleted] })),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.get(token, workspace.id, conversation.id)).toEqual({
      status: 'available',
      value: { ...page, messages: [deleted] },
    });
  });
  it('rejects wrong subject/receipt identity and malformed history instead of exposing private response fields', async () => {
    const client = new ConversationApiClient(
      vi.fn(async () =>
        Response.json({
          conversation: { ...conversation, subject: { kind: 'direct-bot', id: message.id } },
        }),
      ),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.open(token, workspace.id, conversation.subject)).toEqual({
      status: 'unavailable',
    });
    for (const value of [
      { ...receipt, messageId: conversation.id },
      { ...receipt, idempotencyKey: 'private' },
    ]) {
      const client = new ConversationApiClient(
        vi.fn(async () => Response.json({ receipt: value })),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(
        await client.edit(token, workspace.id, conversation.id, message.id, {
          idempotencyKey: 'key',
          expectedVersion: 1,
          body: 'Edit',
        }),
      ).toEqual({ status: 'unavailable' });
    }
    for (const versions of [
      [],
      [version, version],
      [{ ...version, version: 2 }],
      [{ ...version, actor: { ...version.actor, email: 'secret' } }],
      [{ ...version, type: 'message.deleted', body: null, reason: 'Removed' }],
    ]) {
      const client = new ConversationApiClient(
        vi.fn(async () => Response.json({ versions })),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.versions(token, workspace.id, conversation.id, message.id)).toEqual({
        status: 'unavailable',
      });
    }
  });
  it('rejects invalid commands, route IDs and pagination before fetching', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('secret');
    });
    const client = new ConversationApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.get('bad;cookie=inject', workspace.id, conversation.id)).toEqual({
      status: 'anonymous',
    });
    expect(await client.get(token, '../users', conversation.id)).toEqual({ status: 'invalid' });
    expect(await client.get(token, workspace.id, conversation.id, { limit: 101 })).toEqual({
      status: 'invalid',
    });
    expect(
      await client.get(token, workspace.id, conversation.id, { cursor: 'bad/cursor' }),
    ).toEqual({ status: 'invalid' });
    for (const command of [
      { idempotencyKey: 'space key', body: 'Hi' },
      { idempotencyKey: 'key', body: ' ' },
      { idempotencyKey: 'key', body: 'x'.repeat(32001) },
    ])
      expect(await client.append(token, workspace.id, conversation.id, command)).toEqual({
        status: 'invalid',
      });
    expect(
      await client.edit(token, workspace.id, conversation.id, message.id, {
        idempotencyKey: 'key',
        body: 'Edit',
        expectedVersion: 1.5,
      }),
    ).toEqual({ status: 'invalid' });
    expect(
      await client.tombstone(token, workspace.id, conversation.id, message.id, {
        idempotencyKey: 'key',
        expectedVersion: 1,
        reason: ' ',
      }),
    ).toEqual({ status: 'invalid' });
    expect(request).not.toHaveBeenCalled();
    expect(await client.get(token, workspace.id, conversation.id)).toEqual({
      status: 'unavailable',
    });
  });
  it.each([200, 409])(
    'keeps the HTTP %i deadline active while the response body stalls',
    async (status) => {
      let headersSent = false;
      const server = createServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.write('{');
        headersSent = true;
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const originalTimeout = globalThis.setTimeout;
      const timer = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((handler, delay, ...args) =>
          originalTimeout(handler, delay === 30_000 ? 200 : delay, ...args),
        );
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing TCP address');
        const client = new ConversationApiClient(
          fetch,
          `http://127.0.0.1:${address.port}`,
          'http://localhost:3000',
        );
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const missed = new Promise<string>((resolve) => {
          watchdog = originalTimeout(() => resolve('deadline-missed'), 1000);
        });
        try {
          expect(
            await Promise.race([client.get(token, workspace.id, conversation.id), missed]),
          ).toEqual({ status: 'unavailable' });
        } finally {
          clearTimeout(watchdog);
        }
        expect(headersSent).toBe(true);
      } finally {
        timer.mockRestore();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
it('preserves the stable deleted Bot identity on protected readonly conversation history', async () => {
  const value = {
    ...page,
    conversation: {
      ...conversation,
      subject: { kind: 'direct-bot', id: message.id },
      botLifecycleState: 'deleted',
    },
    canWrite: false,
    messages: [{ ...message, canEdit: false, canDelete: false }],
  };
  const client = new ConversationApiClient(
    vi.fn(async () => Response.json(value)),
    'http://api:3001',
    'http://localhost:3000',
  );
  expect(await client.get(token, workspace.id, conversation.id)).toEqual({
    status: 'available',
    value,
  });
});

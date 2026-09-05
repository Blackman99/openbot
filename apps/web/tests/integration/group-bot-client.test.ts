import { createServer } from 'node:http';
import { message } from '../fixtures/conversations.js';
import { describe, expect, it, vi } from 'vitest';
import { GroupBotApiClient } from '../../src/lib/server/group-bot-api.js';
import { token, workspace, group, membership, grant } from '../fixtures/group-bots.js';
describe('Group Bot API client', () => {
  it('reads safe current membership through canonical bodyless authenticated GET', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(membership));
    const client = new GroupBotApiClient(request, 'http://api:3001/', 'http://localhost:3000');
    expect(await client.list(token, workspace.id.toUpperCase(), group.id.toUpperCase())).toEqual({
      status: 'available',
      value: membership,
    });
    expect(request.mock.calls[0]).toMatchObject([
      `http://api:3001/api/v1/workspaces/${workspace.id}/groups/${group.id}/bots`,
      {
        method: 'GET',
        redirect: 'error',
        headers: { origin: 'http://localhost:3000', cookie: `openbot_session=${token}` },
      },
    ]);
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('content-type');
  });
  it('sends an explicit default-future invitation and removes the exact retained grant with unchanged keys', async () => {
    const closed = {
      ...grant,
      closed: { eventId: workspace.id, sequence: 5, at: group.createdAt, reason: 'removed' },
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ grant }))
      .mockResolvedValueOnce(Response.json({ grant: closed }));
    const client = new GroupBotApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(
      await client.invite(token, workspace.id, group.id, {
        botId: grant.bot.id.toUpperCase(),
        idempotencyKey: 'invite-once',
      }),
    ).toEqual({ status: 'available', value: grant });
    expect(request.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        botId: grant.bot.id,
        idempotencyKey: 'invite-once',
        history: { mode: 'future-only' },
      }),
    );
    expect(
      await client.remove(token, workspace.id, group.id, grant.id.toUpperCase(), {
        idempotencyKey: 'remove-once',
      }),
    ).toEqual({ status: 'available', value: closed });
    expect(request.mock.calls[1]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/groups/${group.id}/bots/${grant.id}/remove`,
    );
    expect(request.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ idempotencyKey: 'remove-once' }),
    );
  });

  it.each([
    [401, 'authentication_required', 'anonymous'],
    [403, 'group_bot_forbidden', 'forbidden'],
    [403, 'invalid_origin', 'forbidden'],
    [400, 'invalid_group_bot_request', 'invalid'],
    [409, 'idempotency_conflict', 'idempotency-conflict'],
    [409, 'group_bot_already_active', 'already-active'],
    [409, 'group_bot_limit', 'limit'],
    [409, 'group_bot_inactive', 'inactive'],
    [503, 'group_bot_unavailable', 'unavailable'],
    [500, 'authentication_required', 'unavailable'],
    [200, 'group_bot_forbidden', 'unavailable'],
  ])('maps only matching status/code %s %s', async (status, code, expected) => {
    const client = new GroupBotApiClient(
      vi.fn(async () => Response.json({ error: { code } }, { status: Number(status) })),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.list(token, workspace.id, group.id)).toEqual({ status: expected });
  });

  it('reads only control-free current human projections for the exact grant and opaque cursor', async () => {
    const projected = { ...message, canEdit: false, canDelete: false, canAudit: false };
    const payload = {
      grantId: grant.id,
      conversationId: grant.conversationId,
      messages: [projected],
      nextCursor: 'opaque_cursor',
    };
    const request = vi.fn<typeof fetch>(async () => Response.json(payload));
    const client = new GroupBotApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(
      await client.context(token, workspace.id, group.id, grant.id, {
        cursor: 'prior_cursor',
        limit: 1,
      }),
    ).toEqual({ status: 'available', value: payload });
    expect(String(request.mock.calls[0]?.[0])).toContain(
      `/${grant.id}/context?cursor=prior_cursor&limit=1`,
    );
    for (const invalid of [
      { ...payload, grantId: workspace.id },
      { ...payload, messages: [{ ...projected, canAudit: true }] },
      { ...payload, messages: [{ ...projected, modelBinding: {} }] },
      { ...payload, messages: [projected, projected] },
    ]) {
      request.mockResolvedValueOnce(Response.json(invalid));
      expect(await client.context(token, workspace.id, group.id, grant.id)).toEqual({
        status: 'unavailable',
      });
    }
  });

  it('rejects unsafe nested grants, duplicate active Bots, contradictory counts and mismatched receipts', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new GroupBotApiClient(request, 'http://api:3001', 'http://localhost:3000');
    for (const bad of [
      { ...membership, activeCount: 0 },
      { ...membership, grants: [grant, grant], activeCount: 2 },
      { ...membership, grants: [{ ...grant, bot: { ...grant.bot, instructions: 'secret' } }] },
      { ...membership, grants: [{ ...grant, history: { mode: 'future-only', lowerBound: 1 } }] },
      {
        ...membership,
        grants: [
          {
            ...grant,
            closed: { eventId: workspace.id, sequence: 3, at: group.createdAt, reason: 'removed' },
          },
        ],
      },
      {
        ...membership,
        grants: [{ ...grant, grantedBy: { ...grant.grantedBy, apiKey: 'secret' } }],
      },
      { ...membership, grants: [{ ...grant, history: { mode: 'all', lowerBound: 2 } }] },
      { ...membership, groupId: workspace.id },
    ]) {
      request.mockResolvedValueOnce(Response.json(bad));
      expect(await client.list(token, workspace.id, group.id)).toEqual({ status: 'unavailable' });
    }
    request.mockResolvedValueOnce(
      Response.json({ grant: { ...grant, bot: { ...grant.bot, id: workspace.id } } }),
    );
    expect(
      await client.invite(token, workspace.id, group.id, {
        botId: grant.bot.id,
        idempotencyKey: 'once',
      }),
    ).toEqual({ status: 'unavailable' });
    request.mockResolvedValueOnce(Response.json({ grant }));
    expect(
      await client.remove(token, workspace.id, group.id, grant.id, { idempotencyKey: 'remove' }),
    ).toEqual({ status: 'unavailable' });
  });
  it('preserves all explicit history choices and retained closed invitation replays', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new GroupBotApiClient(request, 'http://api:3001', 'http://localhost:3000');
    for (const history of [
      { mode: 'all' as const },
      { mode: 'since-event' as const, eventId: workspace.id },
      { mode: 'since-time' as const, time: group.createdAt },
    ]) {
      const retained = {
        ...grant,
        history: { ...history, lowerBound: 1 },
        closed: { eventId: workspace.id, sequence: 5, at: group.createdAt, reason: 'removed' },
      };
      request.mockResolvedValueOnce(Response.json({ grant: retained }));
      expect(
        await client.invite(token, workspace.id, group.id, {
          botId: grant.bot.id,
          idempotencyKey: 'once',
          history,
        }),
      ).toEqual({ status: 'available', value: retained });
      expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).history).toEqual(history);
    }
  });
  it('rejects unsafe sessions, route and command inputs before any network request', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new GroupBotApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list('bad; inject=1', workspace.id, group.id)).toEqual({
      status: 'anonymous',
    });
    expect(await client.list(token, '../workspace', group.id)).toEqual({ status: 'invalid' });
    expect(
      await client.invite(token, workspace.id, group.id, {
        botId: grant.bot.id,
        idempotencyKey: 'with space',
      }),
    ).toEqual({ status: 'invalid' });
    expect(
      await client.invite(token, workspace.id, group.id, {
        botId: grant.bot.id,
        idempotencyKey: 'once',
        history: { mode: 'since-time', time: '2026-09-01' },
      }),
    ).toEqual({ status: 'invalid' });
    expect(await client.context(token, workspace.id, group.id, grant.id, { limit: 101 })).toEqual({
      status: 'invalid',
    });
    expect(
      await client.remove(token, workspace.id, group.id, '../grant', { idempotencyKey: 'once' }),
    ).toEqual({ status: 'invalid' });
    const abort = new AbortController();
    abort.abort();
    expect(
      await new GroupBotApiClient(
        request,
        'http://api:3001',
        'http://localhost:3000',
        abort.signal,
      ).list(token, workspace.id, group.id),
    ).toEqual({ status: 'unavailable' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([200, 409])('bounds actual and advertised %i response bodies', async (status) => {
    const overLimit = status === 200 ? 33554433 : 1048577;
    const valid = JSON.stringify(
      status === 200 ? membership : { error: { code: 'group_bot_inactive' } },
    );
    for (const response of [
      new Response(' '.repeat(overLimit) + valid, { status }),
      new Response(valid, { status, headers: { 'content-length': String(overLimit) } }),
    ]) {
      const client = new GroupBotApiClient(
        vi.fn(async () => response),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.list(token, workspace.id, group.id)).toEqual({ status: 'unavailable' });
    }
  });
  it.each([200, 409])(
    'keeps deadline through an actual stalled %i response body',
    async (status) => {
      let sentHeaders = false;
      const server = createServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.write('{');
        sentHeaders = true;
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const original = globalThis.setTimeout;
      const timer = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((handler, delay, ...args) =>
          original(handler, delay === 30000 ? 200 : delay, ...args),
        );
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing port');
        const client = new GroupBotApiClient(
          fetch,
          `http://127.0.0.1:${address.port}`,
          'http://localhost:3000',
        );
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          expect(
            await Promise.race([
              client.list(token, workspace.id, group.id),
              new Promise((resolve) => {
                watchdog = original(() => resolve('deadline-missed'), 1000);
              }),
            ]),
          ).toEqual({ status: 'unavailable' });
        } finally {
          clearTimeout(watchdog);
        }
        expect(sentHeaders).toBe(true);
      } finally {
        timer.mockRestore();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it('accepts a legitimate context page above one MiB without accepting an oversized error', async () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      ...message,
      id: `${String(index + 1).padStart(8, '0')}-ce23-4d77-9c72-fb4e9d01766c`,
      creationSequence: index + 1,
      sequence: index + 1,
      body: 'x'.repeat(32000),
      canEdit: false,
      canDelete: false,
      canAudit: false,
    }));
    const payload = {
      grantId: grant.id,
      conversationId: grant.conversationId,
      messages,
      nextCursor: null,
    };
    const request = vi.fn<typeof fetch>(async () => Response.json(payload));
    const client = new GroupBotApiClient(request, 'http://api:3001', 'http://localhost:3000');
    const result = await client.context(token, workspace.id, group.id, grant.id, { limit: 100 });
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.value.messages).toHaveLength(40);
      expect(result.value.messages.at(-1)?.body?.length).toBe(32000);
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { BotAclApiClient } from '../../src/lib/server/bot-acl-api.js';
import { bot, token, user, workspace } from '../fixtures/bots.js';

const member = {
  user,
  role: 'owner',
  joinedAt: '2026-09-05T00:00:00.000Z',
  hasWorkspaceAccess: true,
};
describe('Bot ACL API client', () => {
  it('reads canonical owner-managed ACLs without JSON headers on bodyless requests', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ members: [member] }));
    const client = new BotAclApiClient(request, 'http://api:3001/', 'http://localhost:3000');
    expect(await client.list(token, workspace.id.toUpperCase(), bot.id.toUpperCase())).toEqual({
      status: 'available',
      value: [member],
    });
    expect(request.mock.calls[0]).toMatchObject([
      `http://api:3001/api/v1/workspaces/${workspace.id}/bots/${bot.id}/acl`,
      { headers: { origin: 'http://localhost:3000', cookie: `openbot_session=${token}` } },
    ]);
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('content-type');
  });
  it.each([
    [401, 'authentication_required', 'anonymous'],
    [403, 'bot_forbidden', 'forbidden'],
    [403, 'invalid_origin', 'forbidden'],
    [400, 'invalid_bot_request', 'invalid'],
    [404, 'bot_acl_member_not_found', 'not-found'],
    [409, 'bot_acl_conflict', 'conflict'],
    [409, 'last_bot_owner_required', 'last-owner'],
    [503, 'bot_unavailable', 'unavailable'],
    [500, 'authentication_required', 'unavailable'],
    [403, 'authentication_required', 'unavailable'],
    [200, 'bot_forbidden', 'unavailable'],
  ])('maps only matching HTTP status %i and code %s', async (status, code, expected) => {
    const client = new BotAclApiClient(
      vi.fn(async () => Response.json({ error: { code } }, { status })),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.list(token, workspace.id, bot.id)).toEqual({ status: expected });
  });
  it('grants default user access, changes roles, revokes without a body, and sets discovery visibility', async () => {
    const granted = { ...member, role: 'user' };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ member: granted }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ member: { ...member, role: 'editor' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ visibility: 'workspace' }));
    const client = new BotAclApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.grant(token, workspace.id, bot.id, user.id.toUpperCase())).toEqual({
      status: 'available',
      value: granted,
    });
    expect(await client.changeRole(token, workspace.id, bot.id, user.id, 'editor')).toEqual({
      status: 'available',
      value: { ...member, role: 'editor' },
    });
    expect(await client.revoke(token, workspace.id, bot.id, user.id)).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(await client.setVisibility(token, workspace.id, bot.id, 'workspace')).toEqual({
      status: 'available',
      value: 'workspace',
    });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ userId: user.id, role: 'user' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(request.mock.calls[1]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/bots/${bot.id}/acl/${user.id}`,
    );
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(request.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty('body');
    expect(request.mock.calls[2]?.[1]?.headers).not.toHaveProperty('content-type');
    expect(request.mock.calls[3]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/bots/${bot.id}/visibility`,
    );
  });
  it('rejects malformed, duplicate and secret-bearing ACL rows and mismatched mutation receipts', async () => {
    for (const members of [
      [member, { ...member, user: { ...user, id: user.id.toUpperCase() } }],
      [{ ...member, apiKey: 'secret' }],
      [{ ...member, user: { ...user, password: 'secret' } }],
      [{ ...member, role: 'administrator' }],
      [{ ...member, joinedAt: 'invalid' }],
      [{ ...member, hasWorkspaceAccess: 'true' }],
      [{ ...member, user: { ...user, id: '../users' } }],
    ]) {
      const client = new BotAclApiClient(
        vi.fn(async () => Response.json({ members })),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.list(token, workspace.id, bot.id)).toEqual({ status: 'unavailable' });
    }
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ member }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ member: { ...member, user: { ...user, id: bot.id } } }),
      )
      .mockResolvedValueOnce(Response.json({ visibility: 'private' }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = new BotAclApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.grant(token, workspace.id, bot.id, user.id)).toEqual({
      status: 'unavailable',
    });
    expect(await client.changeRole(token, workspace.id, bot.id, user.id, 'owner')).toEqual({
      status: 'unavailable',
    });
    expect(await client.setVisibility(token, workspace.id, bot.id, 'workspace')).toEqual({
      status: 'unavailable',
    });
    expect(await client.revoke(token, workspace.id, bot.id, user.id)).toEqual({
      status: 'unavailable',
    });
  });
  it('rejects unsafe route/session inputs before fetch and safely masks network failures', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('secret upstream');
    });
    const client = new BotAclApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list('bad; cookie=inject', workspace.id, bot.id)).toEqual({
      status: 'anonymous',
    });
    expect(await client.list(token, '../workspaces', bot.id)).toEqual({ status: 'invalid' });
    expect(await client.revoke(token, workspace.id, bot.id, '../users')).toEqual({
      status: 'invalid',
    });
    expect(request).not.toHaveBeenCalled();
    expect(await client.list(token, workspace.id, bot.id)).toEqual({ status: 'unavailable' });
  });
  it('sends a bodyless DELETE over actual HTTP', async () => {
    const server = createServer((request, response) => {
      expect(request.method).toBe('DELETE');
      expect(request.headers['content-type']).toBeUndefined();
      response.writeHead(request.headers['content-type'] ? 400 : 204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing TCP address');
      const client = new BotAclApiClient(
        fetch,
        `http://127.0.0.1:${address.port}`,
        'http://localhost:3000',
      );
      expect(await client.revoke(token, workspace.id, bot.id, user.id)).toEqual({
        status: 'available',
        value: undefined,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([200, 409])('keeps the deadline through a stalled HTTP %i body', async (status) => {
    let sentHeaders = false;
    const server = createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.write(status === 200 ? '{"members":[' : '{"error":');
      sentHeaders = true;
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
      const client = new BotAclApiClient(
        fetch,
        `http://127.0.0.1:${address.port}`,
        'http://localhost:3000',
      );
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const missed = new Promise<string>((resolve) => {
        watchdog = originalTimeout(() => resolve('deadline-missed'), 1000);
      });
      try {
        expect(await Promise.race([client.list(token, workspace.id, bot.id), missed])).toEqual({
          status: 'unavailable',
        });
      } finally {
        clearTimeout(watchdog);
      }
      expect(sentHeaders).toBe(true);
    } finally {
      timer.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

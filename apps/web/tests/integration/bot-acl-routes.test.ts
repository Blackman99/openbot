import { describe, expect, it, vi } from 'vitest';
import { botAclAction, loadBotPermissionsPage } from '../../src/lib/server/bot-acl-page.js';
import { bot, token, user, workspace } from '../fixtures/bots.js';
const second = {
  id: 'fe661304-a1bc-4767-9a87-c47de763f749',
  email: 'bob@example.com',
  displayName: 'Bob',
};
const owner = {
  user,
  role: 'owner',
  joinedAt: '2026-09-05T00:00:00.000Z',
  hasWorkspaceAccess: true,
};
function context(detail: unknown = bot, members: unknown[] = [owner], workspaceRole = 'member') {
  const request = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces'))
      return Response.json({ workspaces: [{ ...workspace, role: workspaceRole }] });
    if (path.endsWith(`/bots/${bot.id}`)) return Response.json({ bot: detail });
    if (path.endsWith('/acl')) return Response.json({ members });
    if (path.endsWith('/members'))
      return Response.json({
        members: [user, second].map((user) => ({
          user,
          role: 'member',
          joinedAt: owner.joinedAt,
          invitation: null,
        })),
      });
    throw new Error(`Unexpected path ${path}`);
  });
  return {
    fetch: request,
    cookies: {
      get: vi.fn(() => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
    setHeaders: vi.fn(),
  };
}
describe('Bot permissions page', () => {
  it('loads current owner ACL and same-workspace grant candidates without returning configuration', async () => {
    const event = context();
    const result = await loadBotPermissionsPage(
      event,
      workspace.id.toUpperCase(),
      bot.id.toUpperCase(),
    );
    expect(result).toMatchObject({
      bot: { id: bot.id, name: bot.name, visibility: 'private' },
      members: [owner],
      candidates: [second],
    });
    expect(JSON.stringify(result)).not.toContain('instructions');
    expect(event.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it.each(['editor', 'user', null])(
    'denies permission management to Bot role %s even when workspace owner',
    async (accessRole) => {
      const event = context(
        accessRole === null
          ? { ...bot, currentVersion: undefined, accessRole, visibility: 'workspace' }
          : { ...bot, accessRole },
        [owner],
        'owner',
      );
      await expect(loadBotPermissionsPage(event, workspace.id, bot.id)).rejects.toMatchObject({
        status: 403,
      });
      expect(event.cookies.delete).not.toHaveBeenCalled();
      expect(event.fetch.mock.calls.some(([url]) => String(url).endsWith('/acl'))).toBe(false);
    },
  );
  it('rejects a stale owner snapshot using the current ACL and does not fetch workspace candidates', async () => {
    const event = context(bot, [{ ...owner, role: 'editor' }]);
    await expect(loadBotPermissionsPage(event, workspace.id, bot.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(event.fetch.mock.calls.some(([url]) => String(url).endsWith('/members'))).toBe(false);
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });
  it('grants access and visibility through allowlisted server actions', async () => {
    const event = context();
    event.fetch.mockResolvedValueOnce(
      Response.json({ member: { ...owner, user: second, role: 'editor' } }, { status: 201 }),
    );
    const request = new Request('http://localhost:3000/permissions?/grant', {
      method: 'POST',
      body: new URLSearchParams({ userId: second.id.toUpperCase(), role: 'editor' }),
    });
    expect(await botAclAction({ ...event, request }, workspace.id, bot.id, 'grant')).toMatchObject({
      action: 'grant',
      message: 'Bob now has editor access.',
    });
    expect(event.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ userId: second.id, role: 'editor' }),
    });
    event.fetch.mockResolvedValueOnce(Response.json({ visibility: 'workspace' }));
    expect(
      await botAclAction(
        {
          ...event,
          request: new Request('http://localhost:3000/permissions?/visibility', {
            method: 'POST',
            body: new URLSearchParams({ visibility: 'workspace' }),
          }),
        },
        workspace.id,
        bot.id,
        'visibility',
      ),
    ).toMatchObject({ action: 'visibility', message: 'Bot discovery settings saved.' });
  });
  it.each(['changeRole', 'revoke'] as const)(
    'redirects self-%s after success using the authenticated user, retaining the session',
    async (action) => {
      const event = context();
      event.fetch
        .mockResolvedValueOnce(Response.json({ user, workspace: null }))
        .mockResolvedValueOnce(
          action === 'revoke'
            ? new Response(null, { status: 204 })
            : Response.json({ member: { ...owner, role: 'editor' } }),
        );
      const request = new Request('http://localhost:3000/permissions', {
        method: 'POST',
        body: new URLSearchParams(
          action === 'revoke'
            ? { userId: user.id.toUpperCase() }
            : { userId: user.id.toUpperCase(), role: 'editor' },
        ),
      });
      await expect(
        botAclAction(
          { ...event, request },
          workspace.id.toUpperCase(),
          bot.id.toUpperCase(),
          action,
        ),
      ).rejects.toMatchObject({
        status: 303,
        location: `/app/workspaces/${workspace.id}/bots${action === 'revoke' ? '' : `/${bot.id}`}`,
      });
      expect(event.cookies.delete).not.toHaveBeenCalled();
    },
  );
  it.each([
    [403, 'bot_forbidden', 'permission'],
    [409, 'last_bot_owner_required', 'current workspace access'],
    [409, 'bot_acl_conflict', 'eligible workspace member'],
    [404, 'bot_acl_member_not_found', 'no longer'],
    [400, 'invalid_bot_request', 'valid workspace member'],
    [503, 'bot_unavailable', 'unavailable'],
  ])(
    'shows safe %i mutation failures without clearing the cookie',
    async (status, code, message) => {
      const event = context();
      event.fetch.mockResolvedValueOnce(Response.json({ error: { code } }, { status }));
      const request = new Request('http://localhost:3000/permissions', {
        method: 'POST',
        body: new URLSearchParams({ userId: second.id, role: 'editor' }),
      });
      expect(
        await botAclAction({ ...event, request }, workspace.id, bot.id, 'grant'),
      ).toMatchObject({ status, data: { error: expect.stringContaining(message) } });
      expect(event.cookies.delete).not.toHaveBeenCalled();
    },
  );
  it('clears only a genuinely rejected session, including reads after revocation', async () => {
    for (const status of [401, 403, 500]) {
      const event = context();
      event.fetch.mockImplementation(async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/me')) return Response.json({ user, workspace: null });
        if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
        if (path.endsWith(`/bots/${bot.id}`)) return Response.json({ bot });
        return Response.json(
          { error: { code: status === 403 ? 'bot_forbidden' : 'authentication_required' } },
          { status },
        );
      });
      await expect(loadBotPermissionsPage(event, workspace.id, bot.id)).rejects.toMatchObject({
        status: status === 401 ? 303 : status === 403 ? 403 : 503,
      });
      expect(event.cookies.delete).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    }
  });
  it('rejects invalid, duplicate and authority-bearing form fields without invoking the API', async () => {
    for (const body of [
      new URLSearchParams({ userId: '../users', role: 'editor' }),
      new URLSearchParams({ userId: second.id, role: 'administrator' }),
      new URLSearchParams({ userId: second.id, role: 'owner', actorUserId: second.id }),
      new URLSearchParams([
        ['userId', second.id],
        ['role', 'owner'],
        ['role', 'user'],
      ]),
    ]) {
      const event = context();
      const request = new Request('http://localhost:3000/permissions', { method: 'POST', body });
      expect(
        await botAclAction({ ...event, request }, workspace.id, bot.id, 'grant'),
      ).toMatchObject({ status: 400 });
      expect(event.fetch).not.toHaveBeenCalled();
    }
  });
  it('retains inactive grants while offering only current ungranted workspace members', async () => {
    const event = context(bot, [
      owner,
      { ...owner, user: second, role: 'editor', hasWorkspaceAccess: false },
    ]);
    expect(await loadBotPermissionsPage(event, workspace.id, bot.id)).toMatchObject({
      candidates: [],
      members: [owner, { user: second, hasWorkspaceAccess: false }],
    });
  });
});

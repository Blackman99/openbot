import { describe, expect, it, vi } from 'vitest';
import {
  loadGroupBotsPage,
  groupBotAction,
  loadGroupBotContextPage,
} from '../../src/lib/server/group-bot-page.js';
import {
  token,
  user,
  workspace,
  group,
  membership,
  grant,
  summary,
} from '../fixtures/group-bots.js';
function context(lifecycleState: 'active' | 'archived' = 'active') {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith(`/groups/${group.id}`)) return Response.json({ group });
    if (path.endsWith(`/groups/${group.id}/bots`)) return Response.json(membership);
    if (path.endsWith('/bots'))
      return Response.json({
        bots: [
          { ...summary, lifecycleState },
          {
            ...summary,
            id: workspace.id,
            accessRole: null,
            visibility: 'workspace',
            name: 'Discovery',
          },
        ],
      });
    if (path.endsWith('/context'))
      return Response.json({
        grantId: grant.id,
        conversationId: grant.conversationId,
        messages: [],
        nextCursor: null,
      });
    throw new Error('Unexpected test API request');
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
    url: new URL(`http://localhost:3000/app/workspaces/${workspace.id}/groups/${group.id}/bots`),
  };
}
function request(values: Record<string, string>, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/group-bots', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams(values),
  });
}
describe('Group Bot page boundary', () => {
  it('excludes archived Bots from the invitation selector', async () => {
    expect(
      (await loadGroupBotsPage(context('archived'), workspace.id, group.id)).candidates,
    ).toEqual([]);
  });
  it('loads safe group membership and direct-use candidates without opening a conversation or loading configuration', async () => {
    const event = context();
    const page = await loadGroupBotsPage(event, workspace.id.toUpperCase(), group.id.toUpperCase());
    expect(page).toMatchObject({
      membership,
      group,
      candidates: [
        { id: summary.id, name: summary.name, roleDescription: summary.roleDescription },
      ],
      commands: { invite: expect.any(String), remove: { [grant.id]: expect.any(String) } },
    });
    expect(page.candidates).toHaveLength(1);
    expect(JSON.stringify(page.candidates)).not.toContain('bindingStatus');
    expect(event.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
    expect(event.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it.each(['invite', 'remove'] as const)(
    'keeps the exact %s command through unknown outcome and retries unchanged',
    async (action) => {
      const event = context();
      const values = {
        idempotencyKey: 'stable-key',
        ...(action === 'invite'
          ? { botId: grant.bot.id, mode: 'since-time', time: group.createdAt }
          : { grantId: grant.id }),
      };
      const closed = {
        ...grant,
        closed: { eventId: workspace.id, sequence: 5, at: group.createdAt, reason: 'removed' },
      };
      event.fetch
        .mockResolvedValueOnce(
          Response.json({ error: { code: 'group_bot_unavailable' } }, { status: 503 }),
        )
        .mockResolvedValueOnce(
          Response.json({
            grant:
              action === 'invite'
                ? {
                    ...grant,
                    history: { mode: 'since-time', time: group.createdAt, lowerBound: 1 },
                  }
                : closed,
          }),
        );
      expect(
        await groupBotAction(
          { ...event, request: request(values) },
          workspace.id,
          group.id,
          action,
        ),
      ).toMatchObject({
        status: 503,
        data: {
          action,
          values,
          uncertain: true,
          error: expect.stringContaining('same command key'),
        },
      });
      await expect(
        groupBotAction({ ...event, request: request(values) }, workspace.id, group.id, action),
      ).rejects.toMatchObject({
        status: 303,
        location: `/app/workspaces/${workspace.id}/groups/${group.id}/bots`,
      });
      expect(event.fetch.mock.calls[0]?.[1]?.body).toBe(event.fetch.mock.calls[1]?.[1]?.body);
      expect(event.cookies.delete).not.toHaveBeenCalled();
    },
  );

  it('loads context only for the requested active grant and retains opaque pagination', async () => {
    const event = context();
    event.url.search = '?cursor=opaque_cursor';
    expect(await loadGroupBotContextPage(event, workspace.id, group.id, grant.id)).toMatchObject({
      grant,
      context: {
        grantId: grant.id,
        conversationId: grant.conversationId,
        messages: [],
        nextCursor: null,
      },
    });
    expect(event.fetch.mock.calls.some(([url]) => String(url).includes('/bots?'))).toBe(false);
    expect(String(event.fetch.mock.calls.at(-1)?.[0])).toContain('/context?cursor=opaque_cursor');
  });

  it('uses current membership management permission and never loads candidates for ordinary members', async () => {
    const event = context();
    const original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation(async (url, init) =>
      String(url).endsWith(`/groups/${group.id}/bots`)
        ? Response.json({ ...membership, canManage: false })
        : original(url, init),
    );
    expect(await loadGroupBotsPage(event, workspace.id, group.id)).toMatchObject({
      candidates: [],
      membership: { canManage: false },
    });
    expect(
      event.fetch.mock.calls.some(
        ([url]) => String(url) === `http://localhost:3001/api/v1/workspaces/${workspace.id}/bots`,
      ),
    ).toBe(false);
  });
  it.each([401, 403, 500])('clears identity only for actual %i on writes', async (status) => {
    const event = context();
    event.fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: status === 403 ? 'group_bot_forbidden' : 'authentication_required' } },
        { status },
      ),
    );
    const result = groupBotAction(
      { ...event, request: request({ idempotencyKey: 'once', botId: grant.bot.id }) },
      workspace.id,
      group.id,
      'invite',
    );
    if (status === 401) {
      await expect(result).rejects.toMatchObject({ status: 303, location: '/sign-in' });
      expect(event.cookies.delete).toHaveBeenCalled();
    } else {
      expect(await result).toMatchObject({ status: status === 403 ? 403 : 503 });
      expect(event.cookies.delete).not.toHaveBeenCalled();
    }
  });
  it.each([
    ['group_bot_limit', 'eight active'],
    ['group_bot_already_active', 'already has'],
    ['group_bot_inactive', 'has closed'],
    ['idempotency_conflict', 'different choices'],
  ])('shows actionable %s conflict without retrying blindly', async (code, phrase) => {
    const event = context();
    event.fetch.mockResolvedValueOnce(Response.json({ error: { code } }, { status: 409 }));
    expect(
      await groupBotAction(
        { ...event, request: request({ idempotencyKey: 'once', botId: grant.bot.id }) },
        workspace.id,
        group.id,
        'invite',
      ),
    ).toMatchObject({
      status: 409,
      data: { conflict: true, uncertain: false, error: expect.stringContaining(phrase) },
    });
  });
  it('rejects external origin, forged identity and duplicate fields before fetch', async () => {
    const event = context();
    const values = { idempotencyKey: 'once', botId: grant.bot.id };
    expect(
      await groupBotAction(
        { ...event, request: request(values, 'https://attacker.example') },
        workspace.id,
        group.id,
        'invite',
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await groupBotAction(
        { ...event, request: request({ ...values, grantedBy: user.id }) },
        workspace.id,
        group.id,
        'invite',
      ),
    ).toMatchObject({ status: 400 });
    const body = new URLSearchParams(values);
    body.append('botId', workspace.id);
    expect(
      await groupBotAction(
        {
          ...event,
          request: new Request(event.url, {
            method: 'POST',
            headers: { origin: event.url.origin },
            body,
          }),
        },
        workspace.id,
        group.id,
        'invite',
      ),
    ).toMatchObject({ status: 400 });
    expect(event.fetch).not.toHaveBeenCalled();
  });
  it('rejects duplicate cursors, revoked access and cross-conversation context without clearing identity', async () => {
    const event = context();
    event.url.search = '?cursor=a&cursor=b';
    await expect(
      loadGroupBotContextPage(event, workspace.id, group.id, grant.id),
    ).rejects.toMatchObject({ status: 400 });
    event.url.search = '';
    const original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation(async (url, init) =>
      String(url).includes('/context')
        ? Response.json({
            grantId: grant.id,
            conversationId: workspace.id,
            messages: [],
            nextCursor: null,
          })
        : original(url, init),
    );
    await expect(
      loadGroupBotContextPage(event, workspace.id, group.id, grant.id),
    ).rejects.toMatchObject({ status: 503 });
    event.fetch.mockImplementation(async (url, init) =>
      String(url).endsWith(`/groups/${group.id}/bots`)
        ? Response.json({ error: { code: 'group_bot_forbidden' } }, { status: 403 })
        : original(url, init),
    );
    await expect(loadGroupBotsPage(event, workspace.id, group.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });
});

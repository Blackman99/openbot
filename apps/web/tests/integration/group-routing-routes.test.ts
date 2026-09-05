import { describe, expect, it, vi } from 'vitest';
import {
  loadGroupRoutingPage,
  updateGroupRouting,
} from '../../src/lib/server/group-routing-page.js';
import { grant, group, membership, setting, token, user, workspace } from '../fixtures/routing.js';
function context(canManage = true) {
  const url = new URL(
    `http://localhost:3000/app/workspaces/${workspace.id}/groups/${group.id}/routing`,
  );
  const request = new Request(url);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith(`/groups/${group.id}`))
      return Response.json({ group: { ...group, role: canManage ? 'owner' : 'member' } });
    if (path.endsWith('/routing')) return Response.json({ routing: { ...setting, canManage } });
    if (path.endsWith(`/groups/${group.id}/bots`))
      return Response.json({ ...membership, canManage });
    throw new Error('Unexpected test request');
  });
  return {
    url,
    request,
    fetch,
    setHeaders: vi.fn(),
    cookies: {
      get: vi.fn(() => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
  };
}
function write(values: Record<string, string>, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/routing?/update', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams(values),
  });
}
describe('Group routing page boundary', () => {
  it('lets current members inspect historical settings without direct Bot access or candidate reads', async () => {
    const event = context(false);
    const closed = {
      ...setting,
      canManage: false,
      defaultLead: { ...setting.defaultLead, closed: true },
    };
    const original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation((url, init) =>
      String(url).endsWith('/routing')
        ? Promise.resolve(Response.json({ routing: closed }))
        : original(url, init),
    );
    expect(
      await loadGroupRoutingPage(event, workspace.id.toUpperCase(), group.id.toUpperCase()),
    ).toMatchObject({ group: { role: 'member' }, routing: closed, candidates: [] });
    expect(event.fetch.mock.calls.some(([url]) => String(url).includes('/bots'))).toBe(false);
    expect(event.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it('offers only retained active grant identities, excluding archived and closed memberships', async () => {
    const event = context();
    const original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation((url, init) =>
      String(url).endsWith('/bots')
        ? Promise.resolve(
            Response.json({
              ...membership,
              activeCount: 2,
              grants: [
                grant,
                {
                  ...grant,
                  id: workspace.id,
                  bot: { ...grant.bot, id: user.id, lifecycleState: 'archived' },
                },
                {
                  ...grant,
                  id: group.id,
                  closed: { eventId: user.id, sequence: 5, at: group.createdAt, reason: 'removed' },
                },
              ],
            }),
          )
        : original(url, init),
    );
    const page = await loadGroupRoutingPage(event, workspace.id, group.id);
    expect(page.candidates).toEqual([
      {
        grantId: grant.id,
        botId: grant.bot.id,
        name: grant.bot.name,
        roleDescription: grant.bot.roleDescription,
      },
    ]);
    expect(JSON.stringify(page.candidates)).not.toContain('configuration');
  });
  it('sends the displayed revision with exact grant or null and redirects after confirmed success', async () => {
    for (const defaultGrantId of [grant.id, '']) {
      const event = context();
      event.fetch.mockResolvedValueOnce(
        Response.json({
          routing: {
            ...setting,
            revision: 4,
            defaultLead: defaultGrantId ? setting.defaultLead : null,
          },
        }),
      );
      await expect(
        updateGroupRouting(
          { ...event, request: write({ expectedRevision: '3', defaultGrantId }) },
          workspace.id,
          group.id,
        ),
      ).rejects.toMatchObject({ status: 303, location: event.url.pathname });
      expect(event.fetch.mock.calls[0]?.[1]?.body).toBe(
        JSON.stringify({ expectedRevision: 3, defaultGrantId: defaultGrantId || null }),
      );
    }
  });
  it.each([
    [409, 'routing_revision_conflict', 'Refresh', true, false],
    [409, 'routing_model_unavailable', 'model', false, false],
    [403, 'routing_forbidden', 'access', false, false],
    [503, 'routing_unavailable', 'Refresh', false, true],
  ] as const)(
    'preserves CAS choices without blind retry after %s %s',
    async (status, code, message, conflict, uncertain) => {
      const event = context();
      event.fetch.mockResolvedValueOnce(Response.json({ error: { code } }, { status }));
      const values = { expectedRevision: '3', defaultGrantId: grant.id };
      expect(
        await updateGroupRouting({ ...event, request: write(values) }, workspace.id, group.id),
      ).toMatchObject({
        status,
        data: { values, conflict, uncertain, error: expect.stringContaining(message) },
      });
      expect(event.fetch).toHaveBeenCalledTimes(1);
      expect(event.cookies.delete).not.toHaveBeenCalled();
    },
  );
  it.each([401, 403, 500])('clears the session only for actual %i', async (status) => {
    const event = context();
    event.fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: status === 403 ? 'routing_forbidden' : 'authentication_required' } },
        { status },
      ),
    );
    const result = updateGroupRouting(
      { ...event, request: write({ expectedRevision: '3', defaultGrantId: '' }) },
      workspace.id,
      group.id,
    );
    if (status === 401) {
      await expect(result).rejects.toMatchObject({ status: 303, location: '/sign-in' });
      expect(event.cookies.delete).toHaveBeenCalled();
    } else {
      expect(await result).toMatchObject({ status: status === 403 ? 403 : 503 });
      expect(event.cookies.delete).not.toHaveBeenCalled();
    }
  });
  it('rejects queries, untrusted origins, forged fields, duplicates and oversized incoming forms before fetching', async () => {
    const event = context();
    event.url.search = '?canManage=true';
    await expect(loadGroupRoutingPage(event, workspace.id, group.id)).rejects.toMatchObject({
      status: 400,
    });
    event.url.search = '';
    const values = { expectedRevision: '3', defaultGrantId: grant.id };
    expect(
      await updateGroupRouting(
        { ...event, request: write(values, 'https://attacker.example') },
        workspace.id,
        group.id,
      ),
    ).toMatchObject({ status: 403 });
    for (const entries of [
      new URLSearchParams({ ...values, actorId: user.id }),
      new URLSearchParams({ ...values, expectedRevision: '03' }),
      new URLSearchParams({ ...values, defaultGrantId: 'not-a-uuid' }),
      new URLSearchParams({ ...values, extra: 'x'.repeat(4096) }),
      new URLSearchParams([...Object.entries(values), ['defaultGrantId', workspace.id]]),
    ]) {
      const request = new Request(event.url, {
        method: 'POST',
        headers: { origin: event.url.origin },
        body: entries,
      });
      expect(await updateGroupRouting({ ...event, request }, workspace.id, group.id)).toMatchObject(
        { status: 400 },
      );
    }
    expect(event.fetch).not.toHaveBeenCalled();
  });
  it('denies revoked group access and does not render management when membership permissions disagree', async () => {
    const event = context();
    const original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation((url, init) =>
      String(url).endsWith('/bots')
        ? Promise.resolve(Response.json({ ...membership, canManage: false }))
        : original(url, init),
    );
    await expect(loadGroupRoutingPage(event, workspace.id, group.id)).rejects.toMatchObject({
      status: 403,
    });
    event.fetch.mockImplementation((url, init) =>
      String(url).endsWith('/routing')
        ? Promise.resolve(Response.json({ error: { code: 'routing_forbidden' } }, { status: 403 }))
        : original(url, init),
    );
    await expect(loadGroupRoutingPage(event, workspace.id, group.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });
  it('reloads settings after a named action failure while rejecting extra URL fields', async () => {
    const event = context();
    event.url.search = '?/update';
    expect(await loadGroupRoutingPage(event, workspace.id, group.id)).toMatchObject({
      routing: setting,
    });
    event.url.search = '?/update&canManage=true';
    await expect(loadGroupRoutingPage(event, workspace.id, group.id)).rejects.toMatchObject({
      status: 400,
    });
  });
});

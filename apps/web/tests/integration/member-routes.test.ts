import { describe, expect, it, vi } from 'vitest';
import {
  changeMemberRoleAction,
  loadMembersPage,
  removeMemberAction,
} from '../../src/lib/server/member-page.js';
const token = 'a'.repeat(43);
const user = { id: 'grace', email: 'grace@example.com', displayName: 'Grace Hopper' };
const workspace = { id: 'workspace-1', name: 'Team', description: '', role: 'owner' };
const member = { user, role: 'member', joinedAt: '2026-09-05T00:00:00.000Z', invitation: null };
function cookies(value?: string) {
  return {
    get: vi.fn(() => value),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}
function form(values: Record<string, string>) {
  return new Request('http://localhost:3000/app/workspaces/workspace-1/members', {
    method: 'POST',
    body: new URLSearchParams(values),
  });
}
describe('members page boundaries', () => {
  it('loads only the selected workspace members and uses their current role for controls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/me')
        ? Response.json({ user, workspace: { id: workspace.id, name: workspace.name } })
        : String(url).endsWith('/workspaces')
          ? Response.json({ workspaces: [workspace] })
          : Response.json({ members: [member] }),
    );
    const setHeaders = vi.fn();
    const page = await loadMembersPage(
      { cookies: cookies(token), fetch, setHeaders },
      'workspace-1',
    );
    expect(page.members).toEqual([member]);
    expect(page.workspace.role).toBe('member');
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(
      'http://localhost:3001/api/v1/workspaces/workspace-1/members',
    );
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it('changes the selected member role through the API and reports the new authority', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ member: { ...member, role: 'administrator' } }),
    );
    const result = await changeMemberRoleAction(
      {
        cookies: cookies(token),
        fetch,
        setHeaders: vi.fn(),
        request: form({
          userId: 'grace',
          role: 'administrator',
          workspaceId: 'forged',
          actorRole: 'owner',
        }),
      },
      'workspace-1',
    );
    expect(result).toEqual({
      action: 'changeRole',
      message: 'Grace Hopper is now an administrator.',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/api/v1/workspaces/workspace-1/members/grace',
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"role":"administrator"}');
  });
  it('redirects after self-removal while retaining the valid account session', async () => {
    const jar = cookies(token);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/me')
        ? Response.json({ user, workspace: null })
        : new Response(null, { status: 204 }),
    );
    await expect(
      removeMemberAction(
        {
          cookies: jar,
          fetch,
          setHeaders: vi.fn(),
          request: form({ userId: 'grace', actorId: 'forged' }),
        },
        'workspace-1',
      ),
    ).rejects.toMatchObject({ status: 303, location: '/app' });
    expect(jar.delete).not.toHaveBeenCalled();
    expect(jar.set).not.toHaveBeenCalled();
  });
  it.each([
    [403, 'member_forbidden', 'You do not have permission'],
    [404, 'target_not_found', 'This member is no longer'],
    [409, 'last_owner_required', 'The workspace must keep at least one owner'],
  ])(
    'preserves HTTP %i and gives actionable feedback for stale or forbidden role changes',
    async (status, code, message) => {
      const jar = cookies(token);
      const result = await changeMemberRoleAction(
        {
          cookies: jar,
          fetch: vi.fn(async () => Response.json({ error: { code } }, { status: Number(status) })),
          setHeaders: vi.fn(),
          request: form({ userId: 'grace', role: 'owner' }),
        },
        'workspace-1',
      );
      expect(result).toMatchObject({
        status,
        data: { action: 'changeRole', error: expect.stringContaining(String(message)) },
      });
      expect(jar.delete).not.toHaveBeenCalled();
    },
  );
  it('rejects malformed targets and roles locally without passing form authority to the service', async () => {
    const fetch = vi.fn();
    const context = { cookies: cookies(token), fetch, setHeaders: vi.fn() };
    expect(
      await changeMemberRoleAction(
        { ...context, request: form({ userId: 'grace', role: 'global-admin' }) },
        'workspace-1',
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await removeMemberAction(
        { ...context, request: form({ userId: '../account' }) },
        'workspace-1',
      ),
    ).toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps a removed user signed in when the members API denies a stale page load', async () => {
    const jar = cookies(token);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/me')
        ? Response.json({ user, workspace: null })
        : String(url).endsWith('/workspaces')
          ? Response.json({ workspaces: [workspace] })
          : Response.json({ error: { code: 'workspace_forbidden' } }, { status: 403 }),
    );
    await expect(
      loadMembersPage({ cookies: jar, fetch, setHeaders: vi.fn() }, 'workspace-1'),
    ).rejects.toMatchObject({ status: 403 });
    expect(jar.delete).not.toHaveBeenCalled();
  });
  it('reports another membership removal and clears only a rejected authentication session', async () => {
    const jar = cookies(token);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/me')
        ? Response.json({ user, workspace: null })
        : new Response(null, { status: 204 }),
    );
    expect(
      await removeMemberAction(
        { cookies: jar, fetch, setHeaders: vi.fn(), request: form({ userId: 'ada' }) },
        'workspace-1',
      ),
    ).toMatchObject({
      action: 'remove',
      message: expect.stringContaining('account and history are preserved'),
    });
    expect(jar.delete).not.toHaveBeenCalled();
    await expect(
      changeMemberRoleAction(
        {
          cookies: jar,
          fetch: vi.fn(async () => new Response(null, { status: 401 })),
          setHeaders: vi.fn(),
          request: form({ userId: 'ada', role: 'member' }),
        },
        'workspace-1',
      ),
    ).rejects.toMatchObject({ status: 303, location: '/sign-in' });
    expect(jar.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
  });
});

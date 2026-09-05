import { describe, expect, it, vi } from 'vitest';
import {
  createGroupAction,
  updateGroupAction,
  addGroupMemberAction,
  changeGroupMemberRoleAction,
  removeGroupMemberAction,
  loadGroupsPage,
  loadGroupPage,
} from '../../src/lib/server/group-page.js';
const token = 'a'.repeat(43);
const user = { id: 'ada', email: 'ada@example.com', displayName: 'Ada' };
const workspace = { id: 'workspace-1', name: 'Team', description: '', role: 'owner' };
const group: import('../../src/lib/server/group-api.js').Group = {
  id: 'group-1',
  workspaceId: workspace.id,
  name: 'Research',
  description: '',
  visibility: 'workspace',
  role: null,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};
const member = { user, role: 'member', joinedAt: group.createdAt, hasWorkspaceAccess: true };
function cookies(value: string | undefined = token) {
  return {
    get: vi.fn(() => value),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}
function context(groupPayload = group) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me'))
      return Response.json({ user, workspace: { id: workspace.id, name: workspace.name } });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith('/groups')) return Response.json({ groups: [groupPayload] });
    if (path.endsWith('/groups/group-1')) return Response.json({ group: groupPayload });
    if (path.endsWith('/groups/group-1/members')) return Response.json({ members: [member] });
    throw new Error(`Unexpected route ${path}`);
  });
  return { cookies: cookies(), fetch, setHeaders: vi.fn() };
}
function form(values: Record<string, string>) {
  return new Request('http://localhost:3000/app/workspaces/workspace-1/groups', {
    method: 'POST',
    body: new URLSearchParams(values),
  });
}
describe('group page boundaries', () => {
  it('lists selected-workspace groups and loads metadata only for discoverable nonmembers', async () => {
    const ctx = context();
    expect(await loadGroupsPage(ctx, workspace.id)).toMatchObject({ workspace, groups: [group] });
    const page = await loadGroupPage(ctx, workspace.id, group.id);
    expect(page).toMatchObject({ group, members: [], candidates: [] });
    expect(ctx.fetch.mock.calls.some(([url]) => String(url).endsWith('/members'))).toBe(false);
    expect(ctx.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it('uses fresh explicit group membership rather than workspace authority or a stale metadata role', async () => {
    const ctx = context({ ...group, role: 'owner' });
    expect(await loadGroupPage(ctx, workspace.id, group.id)).toMatchObject({
      group: { role: 'member' },
      members: [member],
      candidates: [],
    });
    expect(ctx.fetch.mock.calls.filter(([url]) => String(url).endsWith('/members'))).toHaveLength(
      1,
    );
  });
  it('loads eligible workspace candidates only for a current group manager', async () => {
    const ctx = context({ ...group, role: 'owner' });
    const baseFetch = ctx.fetch.getMockImplementation()!;
    const candidate = {
      user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace' },
      role: 'member',
      joinedAt: group.createdAt,
      invitation: null,
    };
    ctx.fetch.mockImplementation(async (url, init) =>
      String(url).endsWith('/groups/group-1/members')
        ? Response.json({ members: [{ ...member, role: 'admin' }] })
        : String(url).endsWith('/workspaces/workspace-1/members')
          ? Response.json({
              members: [{ ...member, invitation: null, hasWorkspaceAccess: undefined }, candidate],
            })
          : baseFetch(url, init),
    );
    expect(await loadGroupPage(ctx, workspace.id, group.id)).toMatchObject({
      group: { role: 'admin' },
      candidates: [candidate],
    });
  });
  it('forwards only metadata and explicit human membership commands within route scope', async () => {
    const ctx = context();
    ctx.fetch.mockResolvedValueOnce(
      Response.json({ group: { ...group, role: 'owner', visibility: 'private' } }, { status: 201 }),
    );
    await expect(
      createGroupAction(
        { ...ctx, request: form({ name: 'Research', actorRole: 'owner', workspaceId: 'forged' }) },
        workspace.id,
      ),
    ).rejects.toMatchObject({
      status: 303,
      location: '/app/workspaces/workspace-1/groups/group-1',
    });
    expect(ctx.fetch.mock.calls[0]?.[1]?.body).toBe(
      '{"name":"Research","description":"","visibility":"private"}',
    );
    ctx.fetch.mockResolvedValueOnce(
      Response.json({ group: { ...group, name: 'Planning', role: 'owner' } }),
    );
    expect(
      await updateGroupAction(
        { ...ctx, request: form({ name: 'Planning', description: '', visibility: 'workspace' }) },
        workspace.id,
        group.id,
      ),
    ).toMatchObject({ action: 'update', message: 'Group settings saved.' });
    ctx.fetch.mockResolvedValueOnce(Response.json({ member }, { status: 201 }));
    expect(
      await addGroupMemberAction(
        { ...ctx, request: form({ userId: user.id, role: 'member' }) },
        workspace.id,
        group.id,
      ),
    ).toMatchObject({ action: 'add', message: 'Ada added to the group.' });
    ctx.fetch.mockResolvedValueOnce(Response.json({ member: { ...member, role: 'admin' } }));
    expect(
      await changeGroupMemberRoleAction(
        { ...ctx, request: form({ userId: user.id, role: 'admin' }) },
        workspace.id,
        group.id,
      ),
    ).toMatchObject({ action: 'changeRole', message: 'Ada is now admin.' });
    ctx.fetch
      .mockResolvedValueOnce(Response.json({ user, workspace: null }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      removeGroupMemberAction(
        { ...ctx, request: form({ userId: user.id, actorId: 'forged' }) },
        workspace.id,
        group.id,
      ),
    ).rejects.toMatchObject({ status: 303, location: '/app/workspaces/workspace-1/groups' });
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });
  it.each([
    [403, 'group_forbidden', 'permission'],
    [404, 'group_member_not_found', 'no longer'],
    [409, 'last_group_owner_required', 'current workspace access'],
    [409, 'group_member_conflict', 'already has'],
  ])(
    'preserves %i and the valid session with actionable mutation feedback',
    async (status, code, message) => {
      const ctx = context();
      ctx.fetch.mockResolvedValue(Response.json({ error: { code } }, { status: Number(status) }));
      expect(
        await changeGroupMemberRoleAction(
          { ...ctx, request: form({ userId: 'ada', role: 'owner' }) },
          workspace.id,
          group.id,
        ),
      ).toMatchObject({
        status,
        data: { action: 'changeRole', error: expect.stringContaining(String(message)) },
      });
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    },
  );
  it('clears the cookie only for genuine authentication rejection and masks upstream errors', async () => {
    const ctx = context();
    ctx.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      updateGroupAction({ ...ctx, request: form({ name: 'Research' }) }, workspace.id, group.id),
    ).rejects.toMatchObject({ status: 303, location: '/sign-in' });
    expect(ctx.cookies.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
    const unavailable = context();
    unavailable.fetch.mockResolvedValueOnce(Response.json({ password: 'secret' }, { status: 500 }));
    await expect(
      updateGroupAction(
        { ...unavailable, request: form({ name: 'Research' }) },
        workspace.id,
        group.id,
      ),
    ).rejects.toMatchObject({ status: 503, body: { message: 'Group service unavailable' } });
    expect(unavailable.cookies.delete).not.toHaveBeenCalled();
  });
  it('rejects invalid form roles, paths and metadata without forwarding forged authority', async () => {
    const ctx = context();
    expect(
      await createGroupAction({ ...ctx, request: form({ name: '  ' }) }, workspace.id),
    ).toMatchObject({ status: 400 });
    expect(
      await addGroupMemberAction(
        { ...ctx, request: form({ userId: 'ada', role: 'administrator' }) },
        workspace.id,
        group.id,
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await removeGroupMemberAction(
        { ...ctx, request: form({ userId: '../users' }) },
        workspace.id,
        group.id,
      ),
    ).toMatchObject({ status: 400 });
    expect(ctx.fetch).not.toHaveBeenCalled();
  });
  it('denies a revoked selected workspace instead of redirecting to another workspace or clearing identity', async () => {
    const ctx = context();
    ctx.fetch
      .mockResolvedValueOnce(
        Response.json({ user, workspace: { id: 'other-workspace', name: 'Other' } }),
      )
      .mockResolvedValueOnce(
        Response.json({ workspaces: [{ ...workspace, id: 'other-workspace' }] }),
      );
    await expect(loadGroupsPage(ctx, workspace.id)).rejects.toMatchObject({ status: 403 });
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });
  it('rejects a stale explicit grant when the member read now denies access', async () => {
    const ctx = context({ ...group, role: 'owner' });
    const baseFetch = ctx.fetch.getMockImplementation()!;
    ctx.fetch.mockImplementation(async (url, init) =>
      String(url).endsWith('/members')
        ? Response.json({ error: { code: 'group_forbidden' } }, { status: 403 })
        : baseFetch(url, init),
    );
    await expect(loadGroupPage(ctx, workspace.id, group.id)).rejects.toMatchObject({ status: 403 });
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });
  it('preserves the session and reports removal of another group member', async () => {
    const ctx = context();
    ctx.fetch
      .mockResolvedValueOnce(Response.json({ user, workspace: null }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(
      await removeGroupMemberAction(
        { ...ctx, request: form({ userId: 'grace' }) },
        workspace.id,
        group.id,
      ),
    ).toMatchObject({
      action: 'remove',
      message: expect.stringContaining('account and history are preserved'),
    });
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });
});

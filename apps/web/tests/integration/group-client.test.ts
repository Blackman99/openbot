import { describe, expect, it, vi } from 'vitest';
import { GroupApiClient } from '../../src/lib/server/group-api.js';
const token = 'a'.repeat(43);
const group = {
  id: 'group-1',
  workspaceId: 'workspace-1',
  name: 'Research',
  description: '',
  visibility: 'private',
  role: 'owner',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};
describe('group API client', () => {
  it('creates private groups and lists only validated metadata for the selected workspace', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ group }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ groups: [group] }));
    const client = new GroupApiClient(request, 'http://api:3001/', 'http://localhost:3000');
    expect(await client.create(token, 'workspace-1', { name: 'Research' })).toEqual({
      status: 'available',
      value: group,
    });
    expect(request.mock.calls[0]).toMatchObject([
      'http://api:3001/api/v1/workspaces/workspace-1/groups',
      {
        method: 'POST',
        body: '{"name":"Research"}',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: `openbot_session=${token}`,
        },
      },
    ]);
    expect(await client.list(token, 'workspace-1')).toEqual({
      status: 'available',
      value: [group],
    });
    expect(request.mock.calls[1]?.[1]?.headers).not.toHaveProperty('content-type');
  });
  it('reads and edits only the selected group and manages explicit human grants', async () => {
    const member = {
      user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace' },
      role: 'member',
      joinedAt: '2026-09-05T00:00:00.000Z',
      hasWorkspaceAccess: true,
    };
    const updated = { ...group, name: 'Planning', visibility: 'workspace' };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ group }))
      .mockResolvedValueOnce(Response.json({ group: updated }))
      .mockResolvedValueOnce(Response.json({ members: [member] }))
      .mockResolvedValueOnce(Response.json({ member }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ member: { ...member, role: 'admin' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new GroupApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.get(token, 'workspace-1', 'group-1')).toEqual({
      status: 'available',
      value: group,
    });
    expect(
      await client.update(token, 'workspace-1', 'group-1', {
        name: 'Planning',
        visibility: 'workspace',
      }),
    ).toEqual({ status: 'available', value: updated });
    expect(await client.members(token, 'workspace-1', 'group-1')).toEqual({
      status: 'available',
      value: [member],
    });
    expect(await client.addMember(token, 'workspace-1', 'group-1', 'grace', 'member')).toEqual({
      status: 'available',
      value: member,
    });
    expect(await client.changeRole(token, 'workspace-1', 'group-1', 'grace', 'admin')).toEqual({
      status: 'available',
      value: { ...member, role: 'admin' },
    });
    expect(await client.removeMember(token, 'workspace-1', 'group-1', 'grace')).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(request.mock.calls[3]).toMatchObject([
      'http://api:3001/api/v1/workspaces/workspace-1/groups/group-1/members',
      { method: 'POST', body: '{"userId":"grace","role":"member"}' },
    ]);
    expect(request.mock.calls[4]?.[1]).toMatchObject({ method: 'PATCH', body: '{"role":"admin"}' });
    expect(request.mock.calls[5]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(request.mock.calls[5]?.[1]?.headers).not.toHaveProperty('content-type');
  });
  it.each([
    [400, 'invalid_group_request', 'invalid'],
    [401, 'authentication_required', 'anonymous'],
    [403, 'group_forbidden', 'forbidden'],
    [404, 'group_member_not_found', 'not-found'],
    [409, 'group_member_conflict', 'conflict'],
    [409, 'last_group_owner_required', 'last-owner'],
    [409, 'unknown', 'unavailable'],
    [500, 'internal_secret', 'unavailable'],
  ])('maps %i %s to a safe result', async (status, code, expected) => {
    const client = new GroupApiClient(
      vi.fn(async () => Response.json({ error: { code } }, { status: Number(status) })),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.removeMember(token, 'workspace-1', 'group-1', 'grace')).toEqual({
      status: expected,
    });
  });
  it('rejects cross-workspace, private-field and duplicate metadata instead of exposing it', async () => {
    for (const payload of [
      { groups: [{ ...group, workspaceId: 'other' }] },
      { groups: [{ ...group, privateKey: 'secret' }] },
      { groups: [group, group] },
      { groups: [{ ...group, role: null }] },
    ]) {
      const client = new GroupApiClient(
        vi.fn(async () => Response.json(payload)),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.list(token, 'workspace-1')).toEqual({ status: 'unavailable' });
    }
  });
  it('rejects duplicate or private member data and mismatched command responses', async () => {
    const member = {
      user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace' },
      role: 'member',
      joinedAt: group.createdAt,
      hasWorkspaceAccess: false,
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ members: [member, member] }))
      .mockResolvedValueOnce(
        Response.json({
          members: [{ ...member, user: { ...member.user, passwordHash: 'secret' } }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ member: { ...member, role: 'owner' } }))
      .mockResolvedValueOnce(Response.json({ group: { ...group, id: 'other' } }));
    const client = new GroupApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.members(token, 'workspace-1', 'group-1')).toEqual({
      status: 'unavailable',
    });
    expect(await client.members(token, 'workspace-1', 'group-1')).toEqual({
      status: 'unavailable',
    });
    expect(await client.changeRole(token, 'workspace-1', 'group-1', 'grace', 'admin')).toEqual({
      status: 'unavailable',
    });
    expect(await client.get(token, 'workspace-1', 'group-1')).toEqual({ status: 'unavailable' });
  });
  it('never forwards malformed sessions and masks transport failures', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('private upstream details');
    });
    const client = new GroupApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list('bad; injected=cookie', 'workspace-1')).toEqual({
      status: 'anonymous',
    });
    expect(request).not.toHaveBeenCalled();
    expect(await client.list(token, 'workspace-1')).toEqual({ status: 'unavailable' });
  });
  it('matches uppercase UUID route inputs to canonical IDs while keeping arbitrary fixture IDs case-sensitive', async () => {
    const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
    const groupId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
    const userId = 'cdcc0832-ce23-4d77-9c72-fb4e9d01766c';
    const canonical = { ...group, id: groupId, workspaceId };
    const member = {
      user: { id: userId, email: 'grace@example.com', displayName: 'Grace' },
      role: 'admin',
      joinedAt: group.createdAt,
      hasWorkspaceAccess: true,
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ groups: [canonical] }))
      .mockResolvedValueOnce(Response.json({ group: canonical }))
      .mockResolvedValueOnce(Response.json({ member }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ groups: [group] }));
    const client = new GroupApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list(token, workspaceId.toUpperCase())).toEqual({
      status: 'available',
      value: [canonical],
    });
    expect(await client.get(token, workspaceId.toUpperCase(), groupId.toUpperCase())).toEqual({
      status: 'available',
      value: canonical,
    });
    expect(
      await client.changeRole(
        token,
        workspaceId.toUpperCase(),
        groupId.toUpperCase(),
        userId.toUpperCase(),
        'admin',
      ),
    ).toEqual({ status: 'available', value: member });
    expect(
      await client.removeMember(
        token,
        workspaceId.toUpperCase(),
        groupId.toUpperCase(),
        userId.toUpperCase(),
      ),
    ).toEqual({ status: 'available', value: undefined });
    expect(request.mock.calls[3]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspaceId}/groups/${groupId}/members/${userId}`,
    );
    expect(await client.list(token, 'WORKSPACE-1')).toEqual({ status: 'unavailable' });
  });
});

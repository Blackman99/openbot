import { describe, expect, it, vi } from 'vitest';
import { MemberApiClient } from '../../src/lib/server/member-api.js';

const token = 'a'.repeat(43);
const member = {
  user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace Hopper' },
  role: 'member',
  joinedAt: '2026-09-05T00:00:00.000Z',
  invitation: { id: 'invite-1', invitedBy: { id: 'ada', displayName: 'Ada Lovelace' } },
};

describe('workspace member API client', () => {
  it('lists membership and invitation provenance using the selected workspace and session', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ members: [member] }));
    const client = new MemberApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list(token, 'workspace-1')).toEqual({
      status: 'available',
      value: [member],
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      'http://api:3001/api/v1/workspaces/workspace-1/members',
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: { origin: 'http://localhost:3000', cookie: `openbot_session=${token}` },
    });
  });
  it('changes roles and removes only the target membership using protected requests', async () => {
    const updated = { ...member, role: 'administrator' };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ member: updated }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new MemberApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.changeRole(token, 'workspace-1', 'grace', 'administrator')).toEqual({
      status: 'available',
      value: updated,
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      'http://api:3001/api/v1/workspaces/workspace-1/members/grace',
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: '{"role":"administrator"}',
      headers: { origin: 'http://localhost:3000', cookie: `openbot_session=${token}` },
    });
    expect(await client.remove(token, 'workspace-1', 'grace')).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(request.mock.calls[1]?.[0]).toBe(
      'http://api:3001/api/v1/workspaces/workspace-1/members/grace',
    );
    expect(request.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });
  it.each([
    [400, 'invalid'],
    [401, 'anonymous'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'last-owner'],
    [500, 'unavailable'],
  ])('maps HTTP %i without exposing server details', async (status, expected) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: 'last_owner_required' } }, { status: Number(status) }),
    );
    expect(
      await new MemberApiClient(request, 'http://api:3001', 'http://localhost:3000').remove(
        token,
        'workspace-1',
        'grace',
      ),
    ).toEqual({ status: expected });
  });
  it('rejects duplicate users, private fields and mutation responses for another member', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ members: [member, member] }))
      .mockResolvedValueOnce(
        Response.json({
          members: [{ ...member, user: { ...member.user, passwordHash: 'secret' } }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          member: { ...member, user: { ...member.user, id: 'other-user' }, role: 'administrator' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'different_conflict' } }, { status: 409 }),
      );
    const client = new MemberApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list(token, 'workspace-1')).toEqual({ status: 'unavailable' });
    expect(await client.list(token, 'workspace-1')).toEqual({ status: 'unavailable' });
    expect(await client.changeRole(token, 'workspace-1', 'grace', 'administrator')).toEqual({
      status: 'unavailable',
    });
    expect(await client.remove(token, 'workspace-1', 'grace')).toEqual({ status: 'unavailable' });
  });
  it('does not forward malformed sessions and treats network failures as unavailable', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('private service details');
    });
    const client = new MemberApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list('malformed; cookie=secret', 'workspace-1')).toEqual({
      status: 'anonymous',
    });
    expect(request).not.toHaveBeenCalled();
    expect(await client.list(token, 'workspace-1')).toEqual({ status: 'unavailable' });
  });
});

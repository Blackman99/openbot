import { describe, expect, it, vi } from 'vitest';
import { InvitationApiClient } from '../../src/lib/server/invitation-api.js';

const token = 'a'.repeat(43);
const invitation = {
  id: 'invite-1',
  workspaceId: 'workspace-1',
  email: 'grace@example.com',
  role: 'member',
  createdAt: '2026-09-05T00:00:00.000Z',
  expiresAt: '2026-09-12T00:00:00.000Z',
  revokedAt: null,
  consumedAt: null,
};

describe('invitation API client', () => {
  it('creates an invitation in the selected workspace with origin and session protection', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ invitation, token }, { status: 201 }),
    );
    const client = new InvitationApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(
      await client.create(token, 'workspace-1', {
        email: 'grace@example.com',
        role: 'member',
        expiresInDays: 7,
      }),
    ).toEqual({ status: 'available', value: { invitation, token } });
    expect(request.mock.calls[0]?.[0]).toBe(
      'http://api:3001/api/v1/workspaces/workspace-1/invitations',
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { origin: 'http://localhost:3000', cookie: `openbot_session=${token}` },
      body: JSON.stringify({ email: 'grace@example.com', role: 'member', expiresInDays: 7 }),
    });
  });
  it('lists only token-free invitations and revokes an invitation with a protected DELETE', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ invitations: [invitation] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new InvitationApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list(token, 'workspace-1')).toEqual({
      status: 'available',
      value: [invitation],
    });
    expect(await client.revoke(token, 'workspace-1', 'invite-1')).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(request.mock.calls[1]?.[0]).toBe(
      'http://api:3001/api/v1/workspaces/workspace-1/invitations/invite-1',
    );
    expect(request.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('accepts a fragment token only in a POST body and validates a new account session', async () => {
    const identity = {
      user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace Hopper' },
      workspace: { id: 'workspace-1', name: 'Team' },
    };
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(identity, {
        status: 201,
        headers: {
          'set-cookie': `openbot_session=${token}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
        },
      }),
    );
    const client = new InvitationApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(
      await client.accept(undefined, {
        token,
        displayName: 'Grace Hopper',
        email: 'grace@example.com',
        password: 'correct horse battery staple',
      }),
    ).toEqual({
      status: 'available',
      value: {
        identity,
        cookie: { value: token, expires: new Date('2030-02-01T00:00:00.000Z'), secure: false },
      },
    });
    expect(request.mock.calls[0]?.[0]).toBe('http://api:3001/api/v1/invitations/accept');
    expect(request.mock.calls[0]?.[1]?.body).toContain(token);
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('cookie');
  });

  it.each([400, 401, 403, 404, 409, 503])(
    'keeps API failure %i deterministic without surfacing server payloads',
    async (status) => {
      const expected: Record<number, string> = {
        400: 'invalid',
        401: 'anonymous',
        403: 'forbidden',
        404: 'not-found',
        409: 'conflict',
        503: 'unavailable',
      };
      const client = new InvitationApiClient(
        vi.fn(async () => Response.json({ token: 'private-server-data' }, { status })),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.list(token, 'workspace-1')).toEqual({ status: expected[status] });
    },
  );
  it('rejects extra token or hash fields from list results and malformed cookie acceptance', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ invitations: [{ ...invitation, tokenHash: 'secret-hash' }] }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace' },
            workspace: { id: 'workspace-1', name: 'Team' },
          },
          { status: 201, headers: { 'set-cookie': `openbot_session=${token}; Path=/` } },
        ),
      );
    const client = new InvitationApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.list(token, 'workspace-1')).toEqual({ status: 'unavailable' });
    expect(await client.accept(undefined, { token })).toEqual({ status: 'unavailable' });
  });
  it('accepts an existing signed-in user without replacing their session', async () => {
    const identity = {
      user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace' },
      workspace: { id: 'workspace-1', name: 'Team' },
    };
    const client = new InvitationApiClient(
      vi.fn(async () => Response.json(identity)),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.accept(token, { token })).toEqual({
      status: 'available',
      value: { identity },
    });
  });

  it('preserves retry timing for a rate-limited invitation acceptance without exposing the payload', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        { token: 'must-not-escape', password: 'must-not-escape' },
        { status: 429, headers: { 'retry-after': '60' } },
      ),
    );
    const client = new InvitationApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.accept(undefined, { token })).toEqual({
      status: 'rate-limited',
      retryAfterSeconds: 60,
    });
  });

  it.each(['86401', '-1', '1.5', '0060', 'tomorrow', 'Thu, 01 Jan 2027 00:00:00 GMT', ''])(
    'ignores unsafe retry timing %j while preserving a rate limit',
    async (retryAfter) => {
      const client = new InvitationApiClient(
        vi.fn(async () =>
          Response.json({}, { status: 429, headers: { 'retry-after': retryAfter } }),
        ),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.accept(undefined, { token })).toEqual({ status: 'rate-limited' });
    },
  );
});

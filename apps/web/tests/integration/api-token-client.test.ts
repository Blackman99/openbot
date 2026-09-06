import { describe, expect, it, vi } from 'vitest';
import { ApiTokenApiClient } from '../../src/lib/server/api-token-api.js';
const session = 'a'.repeat(43);
const secret = 'ob_' + 'b'.repeat(43);
const token = {
  id: 'token-id',
  creatorUserId: 'user-id',
  workspaceId: 'workspace-id',
  name: 'Automation',
  scopes: ['me:read'],
  createdAt: '2030-01-01T00:00:00.000Z',
  expiresAt: '2030-02-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};
describe('API token BFF client', () => {
  it('creates once, lists redacted metadata, and revokes with a bodyless DELETE', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token, secret }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ tokens: [token], availableScopes: ['me:read', 'bots:read'] }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiTokenApiClient(request, 'http://api.example', 'http://web.example');
    expect(
      await client.create(session, 'workspace-id', {
        name: 'Automation',
        scopes: ['me:read'],
        expiresAt: token.expiresAt,
      }),
    ).toEqual({ status: 'available', value: { token, secret } });
    expect(await client.list(session, 'workspace-id')).toEqual({
      status: 'available',
      value: { tokens: [token], availableScopes: ['me:read', 'bots:read'] },
    });
    expect(await client.revoke(session, 'workspace-id', 'token-id')).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      'content-type': 'application/json',
      origin: 'http://web.example',
      cookie: `openbot_session=${session}`,
    });
    expect(request.mock.calls[1]?.[1]?.headers).not.toHaveProperty('content-type');
    expect(request.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(request.mock.calls[2]?.[1]?.headers).not.toHaveProperty('content-type');
    expect(request.mock.calls[2]?.[1]?.body).toBeUndefined();
  });
  it.each([
    { tokens: [{ ...token, secret }], availableScopes: ['me:read'] },
    { tokens: [{ ...token, tokenDigest: 'c'.repeat(64) }], availableScopes: ['me:read'] },
    { tokens: [{ ...token, workspaceId: 'other-workspace' }], availableScopes: ['me:read'] },
    { tokens: [token, token], availableScopes: ['me:read'] },
    { tokens: [token], availableScopes: ['*'] },
  ])('refuses unsafe or malformed list data at the BFF boundary', async (payload) => {
    const client = new ApiTokenApiClient(
      async () => Response.json(payload),
      'http://api.example',
      'http://web.example',
    );
    expect(await client.list(session, 'workspace-id')).toEqual({ status: 'unavailable' });
  });
  it.each([
    [401, 'anonymous'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [400, 'invalid'],
    [500, 'unavailable'],
  ] as const)(
    'preserves API error %i without exposing its response payload',
    async (code, status) => {
      const client = new ApiTokenApiClient(
        async () => Response.json({ secret }, { status: code }),
        'http://api.example',
        'http://web.example',
      );
      expect(await client.list(session, 'workspace-id')).toEqual({ status });
    },
  );
});

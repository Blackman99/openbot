import { describe, expect, it, vi } from 'vitest';
import {
  createApiTokenAction,
  loadApiTokensPage,
  revokeApiTokenAction,
} from '../../src/lib/server/api-token-page.js';
const session = 'a'.repeat(43);
const secret = 'ob_' + 'b'.repeat(43);
const user = { id: 'user-id', email: 'ada@example.com', displayName: 'Ada' };
const workspace = { id: 'workspace-id', name: 'Team', description: '', role: 'member' };
const token = {
  id: 'token-id',
  creatorUserId: user.id,
  workspaceId: workspace.id,
  name: 'Automation',
  scopes: ['me:read'],
  createdAt: '2030-01-01T00:00:00.000Z',
  expiresAt: '2030-01-31T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};
function cookies() {
  return {
    get: vi.fn(() => session),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}
function form(values: Array<[string, string]>) {
  return new Request('http://localhost:3000/app/workspaces/workspace-id/settings/api-tokens', {
    method: 'POST',
    body: new URLSearchParams(values),
  });
}
describe('API token settings actions', () => {
  it('returns the secret only from creation and loads redacted metadata with no-store headers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00.000Z'));
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') return Response.json({ token, secret }, { status: 201 });
      if (String(url).endsWith('/me'))
        return Response.json({ user, workspace: { id: workspace.id, name: workspace.name } });
      if (String(url).endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
      return Response.json({ tokens: [token], availableScopes: ['me:read'] });
    });
    const context = { cookies: cookies(), fetch: request, setHeaders: vi.fn() };
    try {
      expect(
        await createApiTokenAction(
          {
            ...context,
            request: form([
              ['name', 'Automation'],
              ['scope', 'me:read'],
              ['expiresInDays', '30'],
              ['workspaceId', 'forged'],
            ]),
          },
          workspace.id,
        ),
      ).toEqual({
        action: 'create',
        secret,
        message: 'Copy this token now. It will not be shown again.',
      });
      expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
        name: 'Automation',
        scopes: ['me:read'],
        expiresAt: token.expiresAt,
      });
      const page = await loadApiTokensPage(context, workspace.id);
      expect(page.tokens).toEqual([token]);
      expect(JSON.stringify(page)).not.toContain(secret);
      expect(context.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('revokes using the route workspace and never repeats a creation secret', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const result = await revokeApiTokenAction(
      {
        cookies: cookies(),
        fetch: request,
        setHeaders: vi.fn(),
        request: form([
          ['tokenId', token.id],
          ['workspaceId', 'forged'],
          ['secret', secret],
        ]),
      },
      workspace.id,
    );
    expect(result).toEqual({
      action: 'revoke',
      message: 'Token revoked. It can no longer access the API.',
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/api/v1/workspaces/workspace-id/api-tokens/token-id',
    );
  });
  it.each([['0'], ['366'], ['1.5'], ['bad']])(
    'rejects invalid expiration %s before calling the API',
    async (days) => {
      const request = vi.fn<typeof fetch>();
      const result = await createApiTokenAction(
        {
          cookies: cookies(),
          fetch: request,
          setHeaders: vi.fn(),
          request: form([
            ['name', 'Automation'],
            ['scope', 'me:read'],
            ['expiresInDays', days],
          ]),
        },
        workspace.id,
      );
      expect(result).toMatchObject({ status: 400 });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it('preserves a valid session when workspace access ends and clears an invalid session', async () => {
    const jar = cookies();
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: 'token_forbidden' } }, { status: 403 }),
    );
    expect(
      await revokeApiTokenAction(
        {
          cookies: jar,
          fetch: request,
          setHeaders: vi.fn(),
          request: form([['tokenId', token.id]]),
        },
        workspace.id,
      ),
    ).toMatchObject({ status: 403 });
    expect(jar.delete).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(
      Response.json({ error: { code: 'authentication_required' } }, { status: 401 }),
    );
    await expect(
      revokeApiTokenAction(
        {
          cookies: jar,
          fetch: request,
          setHeaders: vi.fn(),
          request: form([['tokenId', token.id]]),
        },
        workspace.id,
      ),
    ).rejects.toMatchObject({ status: 303, location: '/sign-in' });
    expect(jar.delete).toHaveBeenCalled();
  });
});

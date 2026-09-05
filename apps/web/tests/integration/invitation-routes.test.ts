import { describe, expect, it, vi } from 'vitest';
import {
  createInvitationAction,
  revokeInvitationAction,
  loadInvitationsPage,
  acceptInvitationAction,
  loadJoinPage,
  signInForInvitationAction,
} from '../../src/lib/server/invitation-page.js';
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
const identity = {
  user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace Hopper' },
  workspace: { id: 'workspace-1', name: 'Team' },
};
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
  return new Request('http://localhost:3000/join', {
    method: 'POST',
    body: new URLSearchParams(values),
  });
}

describe('invitation page boundaries', () => {
  it('creates a copyable fragment link using the route workspace and excludes extra form fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ invitation, token }, { status: 201 }),
    );
    const setHeaders = vi.fn();
    const result = await createInvitationAction(
      {
        fetch,
        cookies: cookies(token),
        setHeaders,
        request: form({
          email: 'grace@example.com',
          role: 'member',
          expiresInDays: '7',
          workspaceId: 'forged',
          password: 'unrelated-secret',
        }),
        url: new URL('http://localhost:3000/app'),
      },
      'workspace-1',
    );
    expect(result).toEqual({
      action: 'create',
      invitationLink: `http://localhost:3000/join#token=${token}`,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/api/v1/workspaces/workspace-1/invitations',
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ email: 'grace@example.com', role: 'member', expiresInDays: 7 }),
    );
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });

  it('loads the admin invitation list and revokes with no token in the result', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/me')
        ? Response.json(identity)
        : String(url).endsWith('/workspaces')
          ? Response.json({
              workspaces: [{ ...identity.workspace, description: '', role: 'administrator' }],
            })
          : String(url).endsWith('/invitations')
            ? Response.json({ invitations: [invitation] })
            : new Response(null, { status: 204 }),
    );
    const context = { cookies: cookies(token), fetch, setHeaders: vi.fn() };
    const page = await loadInvitationsPage(context, 'workspace-1');
    expect(page.invitations).toEqual([invitation]);
    expect(
      await revokeInvitationAction(
        { ...context, request: form({ invitationId: 'invite-1' }) },
        'workspace-1',
      ),
    ).toEqual({ action: 'revoke', revoked: true });
  });

  it('joins as a new account, stores only a validated session and redirects to the joined workspace', async () => {
    const jar = cookies();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(identity, {
        status: 201,
        headers: {
          'set-cookie': `openbot_session=${token}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
        },
      }),
    );
    await expect(
      acceptInvitationAction({
        cookies: jar,
        fetch,
        setHeaders: vi.fn(),
        request: form({
          token,
          displayName: 'Grace Hopper',
          email: 'grace@example.com',
          password: 'correct horse battery staple',
        }),
      }),
    ).rejects.toMatchObject({ status: 303, location: '/app/workspaces/workspace-1' });
    expect(jar.set).toHaveBeenCalledWith(
      'openbot_session',
      token,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });

  it('loads an optional identity without requesting the fragment and signs in without redirecting away from the invitation', async () => {
    expect(await loadJoinPage({ cookies: cookies(), fetch: vi.fn(), setHeaders: vi.fn() })).toEqual(
      { user: null, oidcEnabled: false },
    );
    const jar = cookies();
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(identity, {
        status: 200,
        headers: {
          'set-cookie': `openbot_session=${token}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
        },
      }),
    );
    expect(
      await signInForInvitationAction({
        cookies: jar,
        fetch: request,
        setHeaders: vi.fn(),
        request: form({
          email: 'grace@example.com',
          password: 'correct horse battery staple',
          token: 'never-forward-token',
        }),
      }),
    ).toEqual({ signedIn: true });
    expect(request.mock.calls[0]?.[1]?.body).not.toContain('never-forward-token');
  });
  it('uses only the signed-in session identity and never echoes a failed invitation or password', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: 'invitation_unavailable' } }, { status: 409 }),
    );
    const result = await acceptInvitationAction({
      cookies: cookies(token),
      fetch: request,
      setHeaders: vi.fn(),
      request: form({ token, email: 'forged@example.com', password: 'do-not-echo-password' }),
    });
    expect(result).toMatchObject({ status: 409 });
    expect(request.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ token }));
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('do-not-echo-password');
  });

  it('forbids member invitation management before loading any invitation metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/me')
        ? Response.json(identity)
        : Response.json({
            workspaces: [{ ...identity.workspace, description: '', role: 'member' }],
          }),
    );
    await expect(
      loadInvitationsPage({ cookies: cookies(token), fetch, setHeaders: vi.fn() }, 'workspace-1'),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('handles stale session rejection without retaining invitation or password in the failure', async () => {
    const jar = cookies(token);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: {} }, { status: 401 }),
    );
    const result = await acceptInvitationAction({
      cookies: jar,
      fetch,
      setHeaders: vi.fn(),
      request: form({ token }),
    });
    expect(result).toMatchObject({ status: 401 });
    expect(jar.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('keeps an acceptance rate limit recoverable without returning invitation or account secrets', async () => {
    const jar = cookies();
    const setHeaders = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: { code: 'invitation_rate_limited' } },
        { status: 429, headers: { 'retry-after': '60' } },
      ),
    );
    const result = await acceptInvitationAction({
      cookies: jar,
      fetch,
      setHeaders,
      request: form({ token, email: 'grace@example.com', password: 'do-not-echo-password' }),
    });
    expect(result).toMatchObject({
      status: 429,
      data: { error: 'Too many invitation requests. Try again in 60 seconds.' },
    });
    expect(setHeaders).toHaveBeenCalledWith({ 'retry-after': '60' });
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('do-not-echo-password');
    expect(jar.set).not.toHaveBeenCalled();
  });

  it('keeps management rate limits recoverable and omits untrusted retry headers', async () => {
    const setHeaders = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({}, { status: 429, headers: { 'retry-after': '999999999999999999' } }),
    );
    const result = await createInvitationAction(
      {
        cookies: cookies(token),
        fetch,
        setHeaders,
        url: new URL('http://localhost:3000/app'),
        request: form({ email: 'grace@example.com', role: 'member', expiresInDays: '7' }),
      },
      'workspace-1',
    );
    expect(result).toMatchObject({
      status: 429,
      data: { action: 'create', error: 'Too many invitation requests. Try again later.' },
    });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
});

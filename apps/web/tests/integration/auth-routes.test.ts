import { describe, expect, it, vi } from 'vitest';

import { actions as appActions, load as loadApp } from '../../src/routes/app/+page.server.js';
import { actions as setupActions, load as loadSetup } from '../../src/routes/setup/+page.server.js';
import {
  actions as signInActions,
  load as loadSignIn,
} from '../../src/routes/sign-in/+page.server.js';

const identity = {
  user: { displayName: 'Ada Lovelace', email: 'ada@example.com', id: 'user-id' },
  workspace: { id: 'workspace-id', name: 'My Workspace' },
};
const sessionToken = Buffer.alloc(32, 7).toString('base64url');

function cookieStore(initial?: string) {
  return {
    delete: vi.fn(),
    get: vi.fn((name: string) => (name === 'openbot_session' ? initial : undefined)),
    getAll: vi.fn(() => []),
    serialize: vi.fn(),
    set: vi.fn(),
  };
}

function formRequest(path: string, values: Record<string, string>): Request {
  return new Request(`http://localhost:3000${path}`, {
    body: new URLSearchParams(values),
    method: 'POST',
  });
}

describe('authentication page server routes', () => {
  it('creates the owner through the setup action, stores the session, and redirects to /app', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api.internal:3001');
    vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000');
    const cookies = cookieStore();
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(identity, {
        status: 201,
        headers: {
          'set-cookie': `openbot_session=${sessionToken}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
        },
      }),
    );

    await expect(
      setupActions.default({
        cookies,
        fetch: request,
        request: formRequest('/setup', {
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          password: 'correct horse battery staple',
          setupToken: 'local-only-openbot-setup-token-change-me',
        }),
      } as never),
    ).rejects.toMatchObject({ location: '/app', status: 303 });

    expect(cookies.set).toHaveBeenCalledWith('openbot_session', sessionToken, {
      expires: new Date('2030-02-01T00:00:00.000Z'),
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: false,
    });
  });

  it('redirects a claimed setup page and an unclaimed sign-in page', async () => {
    const claimedFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ claimed: true }),
    );
    await expect(
      loadSetup({ cookies: cookieStore(), fetch: claimedFetch } as never),
    ).rejects.toMatchObject({ location: '/sign-in', status: 303 });

    const unclaimedFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ claimed: false }),
    );
    await expect(
      loadSignIn({ cookies: cookieStore(), fetch: unclaimedFetch, setHeaders: vi.fn() } as never),
    ).rejects.toMatchObject({ location: '/setup', status: 303 });
  });

  it('does not echo a password when sign-in credentials are invalid', async () => {
    const cookies = cookieStore();
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: 'invalid_credentials' } }, { status: 401 }),
    );
    const result = await signInActions.default({
      cookies,
      fetch: request,
      request: formRequest('/sign-in', {
        email: 'ada@example.com',
        password: 'wrong password value',
      }),
      setHeaders: vi.fn(),
    } as never);

    expect(result).toMatchObject({
      data: { email: 'ada@example.com', error: 'Email or password is incorrect.' },
      status: 400,
    });
    expect(JSON.stringify(result)).not.toContain('wrong password value');
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('returns a retryable 429 sign-in response without echoing credentials', async () => {
    const cookies = cookieStore();
    const setHeaders = vi.fn();
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: { code: 'authentication_rate_limited' } },
        { status: 429, headers: { 'retry-after': '60' } },
      ),
    );

    const result = await signInActions.default({
      cookies,
      fetch: request,
      request: formRequest('/sign-in', {
        email: 'ada@example.com',
        password: 'wrong password value',
      }),
      setHeaders,
    } as never);

    expect(result).toMatchObject({
      data: {
        email: 'ada@example.com',
        error: 'Too many sign-in attempts. Try again in 60 seconds.',
      },
      status: 429,
    });
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
    expect(setHeaders).toHaveBeenCalledWith({ 'retry-after': '60' });
    expect(JSON.stringify(result)).not.toContain('wrong password value');
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('does not echo the setup token when the operator token is rejected', async () => {
    const cookies = cookieStore();
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: 'invalid_setup_token' } }, { status: 403 }),
    );
    const result = await setupActions.default({
      cookies,
      fetch: request,
      request: formRequest('/setup', {
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'correct horse battery staple',
        setupToken: 'incorrect-secret-operator-setup-token',
      }),
    } as never);

    expect(result).toMatchObject({
      data: {
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        error: 'Setup token is incorrect.',
      },
      status: 403,
    });
    expect(JSON.stringify(result)).not.toContain('incorrect-secret-operator-setup-token');
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('redirects anonymous and expired sessions away from the protected app page', async () => {
    const anonymousHeaders = vi.fn();
    const anonymousFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ claimed: true }),
    );
    await expect(
      loadApp({
        cookies: cookieStore(),
        fetch: anonymousFetch,
        setHeaders: anonymousHeaders,
      } as never),
    ).rejects.toMatchObject({ location: '/sign-in', status: 303 });
    expect(anonymousHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });

    const expiredCookies = cookieStore(sessionToken);
    const expiredHeaders = vi.fn();
    const expiredFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: {} }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ claimed: true }));
    await expect(
      loadApp({
        cookies: expiredCookies,
        fetch: expiredFetch,
        setHeaders: expiredHeaders,
      } as never),
    ).rejects.toMatchObject({ location: '/sign-in', status: 303 });
    expect(expiredCookies.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
    expect(expiredHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });

  it('loads a protected identity and revokes the session during sign-out', async () => {
    const cookies = cookieStore(sessionToken);
    const setHeaders = vi.fn();
    const authenticatedFetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/workspaces')
        ? Response.json({ workspaces: [{ ...identity.workspace, description: '', role: 'owner' }] })
        : Response.json(identity),
    );

    await expect(
      loadApp({ cookies, fetch: authenticatedFetch, setHeaders } as never),
    ).rejects.toMatchObject({ location: '/app/workspaces/workspace-id', status: 303 });
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });

    const signOutFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 204,
          headers: {
            'set-cookie':
              'openbot_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax',
          },
        }),
    );
    await expect(
      appActions.signOut({ cookies, fetch: signOutFetch, setHeaders } as never),
    ).rejects.toMatchObject({ location: '/sign-in', status: 303 });
    expect(cookies.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
  });

  it('marks the sign-in SSR response as private and non-cacheable', async () => {
    const setHeaders = vi.fn();
    const request = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ claimed: true }));

    await expect(
      loadSignIn({
        cookies: cookieStore(),
        fetch: request,
        setHeaders,
        url: new URL('http://localhost:3000/sign-in'),
      } as never),
    ).resolves.toEqual({ oidcEnabled: false, oidcError: null });
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it('loads conditional OIDC sign-in and renders only allowlisted error messages', async () => {
    const request = vi.fn<typeof fetch>(async (url) =>
      Response.json(String(url).endsWith('/oidc') ? { enabled: true } : { claimed: true }),
    );
    await expect(
      loadSignIn({
        cookies: cookieStore(),
        fetch: request,
        setHeaders: vi.fn(),
        url: new URL('http://localhost:3000/sign-in?oidcError=invalid_flow&code=secret-code'),
      } as never),
    ).resolves.toEqual({
      oidcEnabled: true,
      oidcError: 'This sign-in attempt expired or is invalid. Start again.',
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOidc, completeOidc } from '../../src/lib/server/oidc-flow.js';

const token = 'a'.repeat(43);
const expires = 'Fri, 01 Feb 2030 00:00:00 GMT';
function jar(session?: string, oidc?: string) {
  return {
    get: vi.fn((name: string) =>
      name === 'openbot_session' ? session : name === 'openbot_oidc' ? oidc : undefined,
    ),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}
function event(
  path: string,
  request: typeof fetch,
  cookies = jar(),
  values?: Record<string, string>,
  origin = 'https://openbot.example',
) {
  const url = new URL(`https://openbot.example${path}`);
  return {
    url,
    cookies,
    fetch: request,
    setHeaders: vi.fn(),
    request: new Request(
      url,
      values ? { method: 'POST', headers: { origin }, body: new URLSearchParams(values) } : {},
    ),
  };
}
afterEach(() => vi.unstubAllEnvs());

describe('OIDC document routes', () => {
  it('starts with a document redirect and stores the HttpOnly browser cookie at the callback path', async () => {
    vi.stubEnv('WEB_ORIGIN', 'https://openbot.example');
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { authorizationUrl: 'https://id.example/authorize?state=secret' },
        {
          headers: {
            'set-cookie': `openbot_oidc=${token}; Path=/auth/oidc; Expires=${expires}; HttpOnly; SameSite=Lax; Secure`,
          },
        },
      ),
    );
    const context = event('/auth/oidc/start', fetch, jar(token), {
      purpose: 'link',
      callbackUrl: 'https://evil.example',
      returnTo: 'https://evil.example',
    });
    await expect(startOidc(context)).rejects.toMatchObject({
      status: 303,
      location: 'https://id.example/authorize?state=secret',
    });
    expect(context.cookies.set).toHaveBeenCalledWith('openbot_oidc', token, {
      expires: new Date('2030-02-01T00:00:00.000Z'),
      httpOnly: true,
      path: '/auth/oidc',
      sameSite: 'lax',
      secure: true,
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ purpose: 'link' }));
    expect(context.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
    expect(context.setHeaders).toHaveBeenCalledWith({ 'referrer-policy': 'no-referrer' });
  });
  it('completes only the fixed callback, clears browser state and stores a validated session before redirecting', async () => {
    vi.stubEnv('WEB_ORIGIN', 'https://openbot.example');
    const headers = new Headers();
    headers.append(
      'set-cookie',
      'openbot_oidc=; Path=/auth/oidc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure',
    );
    headers.append(
      'set-cookie',
      `openbot_session=${token}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax; Secure`,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ destination: '/app' }, { headers }),
    );
    const context = event(
      '/auth/oidc/callback?code=secret-code&state=secret-state',
      fetch,
      jar(undefined, token),
    );
    await expect(completeOidc(context)).rejects.toMatchObject({ status: 303, location: '/app' });
    expect(context.cookies.delete).toHaveBeenCalledWith('openbot_oidc', {
      path: '/auth/oidc',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
    expect(context.cookies.set).toHaveBeenCalledWith(
      'openbot_session',
      token,
      expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax', secure: true }),
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        callbackUrl:
          'https://openbot.example/auth/oidc/callback?code=secret-code&state=secret-state',
      }),
    );
  });
  it.each(['https://evil.example', 'null', ''])(
    'rejects a cross-origin start (%s) before API mutation',
    async (origin) => {
      vi.stubEnv('WEB_ORIGIN', 'https://openbot.example');
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        startOidc(event('/auth/oidc/start', fetch, jar(), { purpose: 'signin' }, origin)),
      ).rejects.toMatchObject({ status: 303, location: '/sign-in?oidcError=invalid_flow' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    'https://evil.example/auth/oidc/callback?code=secret',
    'https://openbot.example/wrong?state=secret',
  ])('rejects an unexpected callback URL without forwarding secrets', async (url) => {
    vi.stubEnv('WEB_ORIGIN', 'https://openbot.example');
    const fetch = vi.fn<typeof globalThis.fetch>();
    const context = event('/auth/oidc/callback', fetch, jar(undefined, token));
    context.url = new URL(url);
    await expect(completeOidc(context)).rejects.toMatchObject({
      status: 303,
      location: '/sign-in?oidcError=invalid_flow',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(context.cookies.delete).toHaveBeenCalled();
  });
  it('clears missing browser state and redirects a rejected callback without code, state, or provider text', async () => {
    vi.stubEnv('WEB_ORIGIN', 'https://openbot.example');
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: { code: 'identity_not_linked', description: 'provider-secret' } },
        { status: 409 },
      ),
    );
    const context = event(
      '/auth/oidc/callback?code=secret-code&state=secret-state',
      fetch,
      jar(undefined, token),
    );
    await expect(completeOidc(context)).rejects.toMatchObject({
      status: 303,
      location: '/sign-in?oidcError=identity_not_linked',
    });
    expect(context.cookies.delete).toHaveBeenCalled();
    expect(context.cookies.set).not.toHaveBeenCalled();
    fetch.mockClear();
    await expect(
      completeOidc(event('/auth/oidc/callback?code=secret', fetch)),
    ).rejects.toMatchObject({ status: 303, location: '/sign-in?oidcError=invalid_flow' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('forwards an invitation token only in the start body and rejects malformed invitation tokens', async () => {
    vi.stubEnv('WEB_ORIGIN', 'https://openbot.example');
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: 'invitation_unavailable' } }, { status: 409 }),
    );
    await expect(
      startOidc(
        event('/auth/oidc/start', fetch, jar(), { purpose: 'invite', invitationToken: token }),
      ),
    ).rejects.toMatchObject({ location: '/sign-in?oidcError=invitation_unavailable' });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ purpose: 'invite', invitationToken: token }),
    );
    fetch.mockClear();
    await expect(
      startOidc(
        event('/auth/oidc/start', fetch, jar(), {
          purpose: 'invite',
          invitationToken: 'secret-invalid',
        }),
      ),
    ).rejects.toMatchObject({ location: '/sign-in?oidcError=invalid_flow' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

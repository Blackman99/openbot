import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSecurityPage, unlinkOidcAction } from '../../src/lib/server/oidc-security-page.js';
const token = 'a'.repeat(43);
const user = { id: 'user-1', displayName: 'Ada', email: 'ada@example.com' };
function jar(value?: string) {
  return {
    get: vi.fn(() => value),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('account security page', () => {
  it('redirects anonymous and expired sessions before exposing account controls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: 'authentication_required' } }, { status: 401 }),
    );
    const context = {
      fetch,
      cookies: jar(),
      setHeaders: vi.fn(),
      url: new URL('http://localhost:3000/app/security'),
    };
    await expect(loadSecurityPage(context)).rejects.toMatchObject({
      status: 303,
      location: '/sign-in',
    });
    expect(fetch).not.toHaveBeenCalled();
    const cookies = jar(token);
    await expect(loadSecurityPage({ ...context, cookies })).rejects.toMatchObject({
      status: 303,
      location: '/sign-in',
    });
    expect(cookies.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
  });
  it('omits identity actions when unconfigured and completes an authenticated unlink', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/me')
        ? Response.json({ user, workspace: null })
        : Response.json({ enabled: false }),
    );
    const context = {
      fetch,
      cookies: jar(token),
      setHeaders: vi.fn(),
      url: new URL('http://localhost:3000/app/security'),
    };
    await expect(loadSecurityPage(context)).resolves.toMatchObject({
      oidcEnabled: false,
      linked: false,
      canUnlink: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      unlinkOidcAction({
        ...context,
        request: new Request(context.url, {
          method: 'POST',
          headers: { origin: 'http://localhost:3000' },
        }),
      }),
    ).resolves.toEqual({ unlinked: true });
  });
  it('loads OIDC identity controls for an authenticated account without a workspace', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/me')
        ? Response.json({ user, workspace: null })
        : String(url).endsWith('/oidc')
          ? Response.json({ enabled: true })
          : Response.json({ linked: true, canUnlink: false }),
    );
    const setHeaders = vi.fn();
    await expect(
      loadSecurityPage({
        fetch,
        cookies: jar(token),
        setHeaders,
        url: new URL('http://localhost:3000/app/security'),
      }),
    ).resolves.toEqual({
      user,
      oidcEnabled: true,
      linked: true,
      canUnlink: false,
      oidcError: null,
    });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/workspaces'))).toBe(false);
    expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it('keeps last-credential rejection recoverable and requires the trusted origin to unlink', async () => {
    vi.stubEnv('WEB_ORIGIN', 'https://openbot.example');
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: 'last_credential' } }, { status: 409 }),
    );
    const context = {
      fetch,
      cookies: jar(token),
      setHeaders: vi.fn(),
      url: new URL('https://openbot.example/app/security'),
      request: new Request('https://openbot.example/app/security', {
        method: 'POST',
        headers: { origin: 'https://openbot.example' },
      }),
    };
    await expect(unlinkOidcAction(context)).resolves.toMatchObject({
      status: 409,
      data: {
        error: 'Keep at least one sign-in method. This OIDC identity is your only sign-in method.',
      },
    });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('DELETE');
    fetch.mockClear();
    context.request = new Request('https://openbot.example/app/security', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    await expect(unlinkOidcAction(context)).resolves.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OidcApiClient } from '../../src/lib/server/oidc-api.js';

const token = 'a'.repeat(43);
const cookie = `openbot_oidc=${token}; Path=/auth/oidc; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure`;

describe('OIDC API boundary', () => {
  it('rejects a missing or malformed callback session and supports linking without session rotation', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ destination: '/app' }))
      .mockResolvedValueOnce(
        Response.json(
          { destination: '/app' },
          {
            headers: {
              'set-cookie': `openbot_session=${token}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; SameSite=Lax; Secure`,
            },
          },
        ),
      )
      .mockResolvedValueOnce(Response.json({ destination: '/app/security' }));
    const client = new OidcApiClient(request, 'http://api.internal', 'https://openbot.example');
    await expect(
      client.callback('https://openbot.example/auth/oidc/callback', token),
    ).resolves.toEqual({ status: 'failed', code: 'provider_unavailable' });
    await expect(
      client.callback('https://openbot.example/auth/oidc/callback', token),
    ).resolves.toEqual({ status: 'failed', code: 'provider_unavailable' });
    await expect(
      client.callback('https://openbot.example/auth/oidc/callback', token, token),
    ).resolves.toEqual({ status: 'available', value: { destination: '/app/security' } });
  });
  it('starts an invitation using only the trusted origin and session, and validates the browser cookie', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        { authorizationUrl: 'https://id.example/authorize?state=provider-state' },
        { headers: { 'set-cookie': cookie } },
      ),
    );
    const client = new OidcApiClient(request, 'http://api.internal', 'https://openbot.example');
    await expect(
      client.start({ purpose: 'invite', invitationToken: token }, token),
    ).resolves.toEqual({
      status: 'available',
      value: {
        authorizationUrl: 'https://id.example/authorize?state=provider-state',
        cookie: { value: token, expires: new Date('2030-02-01T00:00:00.000Z'), secure: true },
      },
    });
    expect(request).toHaveBeenCalledWith(
      'http://api.internal/api/v1/oidc/start',
      expect.objectContaining({
        method: 'POST',
        headers: {
          origin: 'https://openbot.example',
          'content-type': 'application/json',
          cookie: `openbot_session=${token}`,
        },
        body: JSON.stringify({ purpose: 'invite', invitationToken: token }),
        redirect: 'error',
        credentials: 'omit',
      }),
    );
  });
  it('completes a callback with separately validated session cookies and an allowlisted destination', async () => {
    const headers = new Headers();
    headers.append(
      'set-cookie',
      'openbot_oidc=; Path=/auth/oidc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure',
    );
    headers.append(
      'set-cookie',
      `openbot_session=${token}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure`,
    );
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ destination: '/app' }, { headers }),
    );
    const client = new OidcApiClient(request, 'http://api.internal', 'https://openbot.example');
    await expect(
      client.callback(
        'https://openbot.example/auth/oidc/callback?code=secret&state=secret-state',
        token,
        token,
      ),
    ).resolves.toEqual({
      status: 'available',
      value: {
        destination: '/app',
        cookie: { value: token, expires: new Date('2030-02-01T00:00:00.000Z'), secure: true },
      },
    });
    expect(request).toHaveBeenCalledWith(
      'http://api.internal/api/v1/oidc/callback',
      expect.objectContaining({
        headers: {
          origin: 'https://openbot.example',
          'content-type': 'application/json',
          cookie: `openbot_session=${token}; openbot_oidc=${token}`,
        },
        body: JSON.stringify({
          callbackUrl: 'https://openbot.example/auth/oidc/callback?code=secret&state=secret-state',
        }),
      }),
    );
  });
  it('reads provider availability and account linking state, and unlinks with the authenticated origin', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ enabled: false }))
      .mockResolvedValueOnce(Response.json({ linked: true, canUnlink: false }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new OidcApiClient(request, 'http://api.internal', 'https://openbot.example');
    await expect(client.enabled()).resolves.toBe(false);
    await expect(client.identity(token)).resolves.toEqual({
      status: 'available',
      value: { linked: true, canUnlink: false },
    });
    await expect(client.unlink(token)).resolves.toEqual({ status: 'available', value: null });
    expect(request).toHaveBeenLastCalledWith(
      'http://api.internal/api/v1/oidc/identity',
      expect.objectContaining({
        method: 'DELETE',
        headers: { cookie: `openbot_session=${token}`, origin: 'https://openbot.example' },
      }),
    );
  });
  it.each([
    [400, 'invalid_flow'],
    [401, 'authentication_required'],
    [409, 'identity_not_linked'],
    [409, 'identity_conflict'],
    [409, 'last_credential'],
    [409, 'invitation_unavailable'],
    [503, 'provider_unavailable'],
    [400, 'untrusted-secret-code'],
  ])('maps only allowlisted failure codes from status %s (%s)', async (status, code) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code, message: 'do-not-reflect' } }, { status }),
    );
    const client = new OidcApiClient(request, 'http://api.internal', 'https://openbot.example');
    const expected = {
      status: 'failed',
      code: code === 'untrusted-secret-code' ? 'provider_unavailable' : code,
    };
    await expect(client.start({ purpose: 'signin' })).resolves.toEqual(expected);
    await expect(
      client.callback('https://openbot.example/auth/oidc/callback', token),
    ).resolves.toEqual(expected);
    await expect(client.identity(token)).resolves.toEqual(expected);
    await expect(client.unlink(token)).resolves.toEqual(expected);
  });
  it.each([
    cookie.replace('HttpOnly', 'Domain=attacker.example'),
    cookie.replace('Path=/auth/oidc', 'Path=/'),
    cookie.replace('SameSite=Lax', 'SameSite=None'),
    cookie.replace('; Secure', ''),
    cookie + '; Path=/auth/oidc',
  ])('rejects unsafe browser cookie attributes', async (unsafeCookie) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        { authorizationUrl: 'https://id.example/authorize' },
        { headers: { 'set-cookie': unsafeCookie } },
      ),
    );
    await expect(
      new OidcApiClient(request, 'http://api.internal', 'https://openbot.example').start({
        purpose: 'signin',
      }),
    ).resolves.toEqual({ status: 'failed', code: 'provider_unavailable' });
  });
  it.each(['//evil.example', 'https://evil.example', '/app?code=secret', '/app/security#secret'])(
    'rejects an unapproved callback destination %s',
    async (destination) => {
      const request = vi.fn<typeof fetch>(async () => Response.json({ destination }));
      await expect(
        new OidcApiClient(request, 'http://api.internal', 'https://openbot.example').callback(
          'https://openbot.example/auth/oidc/callback',
          token,
        ),
      ).resolves.toEqual({ status: 'failed', code: 'provider_unavailable' });
    },
  );
  it('bounds actual HTTP body reads after headers arrive, for availability and all account flows', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP fixture address');
    let expireDeadline: (() => void) | undefined;
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      expireDeadline = () =>
        controller.abort(new DOMException('Test deadline expired', 'TimeoutError'));
      return controller.signal;
    });
    let receivedHeaders = 0;
    const request: typeof fetch = async (...args) => {
      const expire = expireDeadline;
      const response = await fetch(...args);
      receivedHeaders += 1;
      if (!expire) throw new Error('Expected an active request deadline');
      // Expire after real headers arrive so this always exercises a stalled body,
      // even when other integration workers delay the loopback connection.
      queueMicrotask(expire);
      return response;
    };
    try {
      const client = new OidcApiClient(
        request,
        `http://127.0.0.1:${address.port}`,
        'http://localhost:3000',
      );
      await expect(client.enabled()).resolves.toBe(false);
      expect(deadline).toHaveBeenLastCalledWith(2_000);
      await expect(client.identity(token)).resolves.toEqual({
        status: 'failed',
        code: 'provider_unavailable',
      });
      expect(deadline).toHaveBeenLastCalledWith(2_000);
      await expect(client.start({ purpose: 'signin' })).resolves.toEqual({
        status: 'failed',
        code: 'provider_unavailable',
      });
      expect(deadline).toHaveBeenLastCalledWith(30_000);
      await expect(
        client.callback('http://localhost:3000/auth/oidc/callback', token),
      ).resolves.toEqual({ status: 'failed', code: 'provider_unavailable' });
      expect(deadline).toHaveBeenLastCalledWith(30_000);
      expect(receivedHeaders).toBe(4);
    } finally {
      deadline.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

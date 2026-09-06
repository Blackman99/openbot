import { describe, expect, it, vi } from 'vitest';

import { AuthApiClient, type SessionCookie } from '../../src/lib/server/auth-api.js';

const identity = {
  user: { displayName: 'Ada Lovelace', email: 'ada@example.com', id: 'user-id' },
  workspace: { id: 'workspace-id', name: 'My Workspace' },
};

describe('server-side authentication API client', () => {
  it('accepts only exact claim-state and identity contracts', async () => {
    const request = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ claimed: true }))
      .mockResolvedValueOnce(Response.json(identity));
    const client = new AuthApiClient(
      request,
      'http://api.internal:3001/',
      'https://openbot.example',
    );

    await expect(client.getClaimState()).resolves.toEqual({ status: 'available', claimed: true });
    await expect(client.getIdentity('valid_token')).resolves.toEqual({
      status: 'authenticated',
      identity,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      'http://api.internal:3001/api/v1/me',
      expect.objectContaining({ headers: { cookie: 'openbot_session=valid_token' } }),
    );
  });

  it('distinguishes anonymous sessions from an unavailable or malformed API', async () => {
    const request = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: {} }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ user: {}, workspace: {} }))
      .mockRejectedValueOnce(new Error('offline'));
    const client = new AuthApiClient(request, 'http://api.internal:3001', 'http://localhost:3000');

    await expect(client.getIdentity('expired')).resolves.toEqual({ status: 'anonymous' });
    await expect(client.getIdentity('malformed')).resolves.toEqual({ status: 'unavailable' });
    await expect(client.getIdentity('offline')).resolves.toEqual({ status: 'unavailable' });
  });

  it('forwards the trusted origin and returns only a validated session cookie', async () => {
    const expires = 'Fri, 01 Feb 2030 00:00:00 GMT';
    const token = Buffer.alloc(32, 7).toString('base64url');
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(identity, {
        status: 201,
        headers: {
          'set-cookie': `openbot_session=${token}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax; Secure`,
        },
      }),
    );
    const client = new AuthApiClient(
      request,
      'http://api.internal:3001',
      'https://openbot.example/',
    );

    const result = await client.setup({
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
      setupToken: 'local-only-openbot-setup-token-change-me',
    });

    expect(result).toEqual({
      status: 'authenticated',
      identity,
      cookie: {
        expires: new Date('2030-02-01T00:00:00.000Z'),
        secure: true,
        value: token,
      } satisfies SessionCookie,
    });
    expect(request).toHaveBeenCalledWith(
      'http://api.internal:3001/api/v1/setup',
      expect.objectContaining({
        body: JSON.stringify({
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          password: 'correct horse battery staple',
        }),
        headers: expect.objectContaining({
          origin: 'https://openbot.example',
          'x-openbot-setup-token': 'local-only-openbot-setup-token-change-me',
        }),
        method: 'POST',
      }),
    );
  });

  it('rejects incomplete cookie security attributes and maps stable API failures', async () => {
    const request = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(identity, {
          status: 200,
          headers: { 'set-cookie': 'openbot_session=unsafe; Path=/; SameSite=Lax' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'invalid_credentials' } }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'instance_already_claimed' } }, { status: 409 }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'invalid_setup_token' } }, { status: 403 }),
      );
    const client = new AuthApiClient(request, 'http://api.internal:3001', 'http://localhost:3000');

    await expect(
      client.signIn({ email: 'ada@example.com', password: 'correct horse battery staple' }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      client.signIn({ email: 'ada@example.com', password: 'wrong password value' }),
    ).resolves.toEqual({ status: 'invalid-credentials' });
    await expect(
      client.setup({
        displayName: 'Second Owner',
        email: 'second@example.com',
        password: 'another secure password',
        setupToken: 'local-only-openbot-setup-token-change-me',
      }),
    ).resolves.toEqual({ status: 'already-claimed' });
    await expect(
      client.setup({
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'correct horse battery staple',
        setupToken: 'incorrect-secret-operator-setup-token',
      }),
    ).resolves.toEqual({ status: 'invalid-setup-token' });
  });

  it('preserves a bounded Retry-After delay when sign-in is rate limited', async () => {
    const request = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'authentication_rate_limited' } },
          { status: 429, headers: { 'retry-after': '60' } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'authentication_rate_limited' } },
          { status: 429, headers: { 'retry-after': '999999' } },
        ),
      );
    const client = new AuthApiClient(request, 'http://api.internal:3001', 'http://localhost:3000');

    await expect(
      client.signIn({ email: 'ada@example.com', password: 'wrong password value' }),
    ).resolves.toEqual({ status: 'rate-limited', retryAfterSeconds: 60 });
    await expect(
      client.signIn({ email: 'ada@example.com', password: 'wrong password value' }),
    ).resolves.toEqual({ status: 'rate-limited' });
  });

  it('signs out with the trusted origin and session cookie, accepting only a secure clear-cookie', async () => {
    const request = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 204,
          headers: {
            'set-cookie':
              'openbot_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
          },
        }),
    );
    const client = new AuthApiClient(
      request,
      'http://api.internal:3001',
      'https://openbot.example',
    );

    await expect(client.signOut('valid_token')).resolves.toEqual({
      status: 'signed-out',
      secure: true,
    });
    expect(request).toHaveBeenCalledWith(
      'http://api.internal:3001/api/v1/session',
      expect.objectContaining({
        headers: { cookie: 'openbot_session=valid_token', origin: 'https://openbot.example' },
        method: 'DELETE',
      }),
    );
  });

  it('allows bounded time for intentionally expensive password hashing', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof globalThis.fetch>(
        async (_input, init) =>
          new Promise<Response>((resolve) => {
            init?.signal?.addEventListener('abort', () => {
              resolve(Response.json({ error: {} }, { status: 503 }));
            });
          }),
      );
      const client = new AuthApiClient(
        request,
        'http://api.internal:3001',
        'http://localhost:3000',
      );
      let settled = false;
      const result = client
        .signIn({ email: 'ada@example.com', password: 'correct horse battery staple' })
        .then((value) => {
          settled = true;
          return value;
        });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(28_000);
      await expect(result).resolves.toEqual({ status: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('recognizes an authenticated account with no accessible workspace', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ user: identity.user, workspace: null }),
    );
    const client = new AuthApiClient(request, 'http://api.internal:3001', 'http://localhost:3000');
    await expect(client.getIdentity('valid_token')).resolves.toEqual({
      status: 'authenticated',
      identity: { user: identity.user, workspace: null },
    });
  });
});

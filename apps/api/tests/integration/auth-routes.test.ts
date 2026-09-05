import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { AuthenticationAttemptLimiter } from '../../src/auth/attempt-limiter.js';
import { InstanceAlreadyClaimedError } from '../../src/auth/repository.js';
import {
  AuthenticationBusyError,
  InvalidCredentialsError,
  type AuthService,
} from '../../src/auth/service.js';
import type { ReadinessProbe } from '../../src/readiness.js';

const readiness: ReadinessProbe = {
  check: async () => ({ database: 'ready', migrations: 'current' }),
};
const setupToken = 'local-only-openbot-setup-token-change-me';
const setupTokenDigest = '4b5d9e48b8fbcf6584a8919aec8686de5a09e4a6310a8488c83a442e8bb88b7e';

function authService(overrides: Partial<AuthService>): AuthService {
  return {
    getSession: async () => undefined,
    isClaimed: async () => false,
    signIn: async () => {
      throw new Error('Unexpected sign-in call');
    },
    signOut: async () => false,
    setup: async () => {
      throw new Error('Unexpected setup call');
    },
    ...overrides,
  };
}

describe('local-owner authentication routes', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('claims an instance and sets a secure persistent session without exposing its token', async () => {
    const expiresAt = new Date('2030-02-01T00:00:00.000Z');
    const setup = vi.fn<AuthService['setup']>(async () => ({
      expiresAt,
      sessionToken: 'session-secret',
      user: {
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        id: '00000000-0000-4000-8000-000000000001',
      },
      workspace: {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'My Workspace',
      },
    }));
    const auth = authService({ setup });
    const app = buildApp({
      auth,
      readiness,
      setupTokenDigest,
      webOrigin: 'https://openbot.example',
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        origin: 'https://openbot.example',
        'x-openbot-setup-token': setupToken,
      },
      method: 'POST',
      payload: {
        displayName: 'Ada Lovelace',
        email: 'Ada@Example.com',
        password: 'correct horse battery staple',
      },
      url: '/api/v1/setup',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      user: {
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        id: '00000000-0000-4000-8000-000000000001',
      },
      workspace: {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'My Workspace',
      },
    });
    expect(JSON.stringify(response.json())).not.toMatch(/password|secret|token/iu);
    expect(response.headers['set-cookie']).toContain('openbot_session=session-secret');
    expect(response.headers['set-cookie']).toContain('Path=/');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(response.headers['set-cookie']).toContain('Expires=Fri, 01 Feb 2030 00:00:00 GMT');
    expect(setup).toHaveBeenCalledWith({
      displayName: 'Ada Lovelace',
      email: 'Ada@Example.com',
      password: 'correct horse battery staple',
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('maps a lost setup race to a stable conflict without setting a session cookie', async () => {
    const auth = authService({
      setup: vi.fn<AuthService['setup']>(async () => {
        throw new InstanceAlreadyClaimedError();
      }),
    });
    const app = buildApp({ auth, readiness, setupTokenDigest, webOrigin: 'http://localhost:3000' });
    apps.push(app);

    const response = await app.inject({
      headers: {
        origin: 'http://localhost:3000',
        'x-openbot-setup-token': setupToken,
      },
      method: 'POST',
      payload: {
        displayName: 'Second Owner',
        email: 'second@example.com',
        password: 'another secure password',
      },
      url: '/api/v1/setup',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'instance_already_claimed' } });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('signs in with a new persistent cookie and maps invalid credentials to HTTP 401', async () => {
    const signIn = vi.fn<AuthService['signIn']>(async ({ email }) => {
      if (email === 'missing@example.com') {
        throw new InvalidCredentialsError();
      }

      return {
        expiresAt: new Date('2030-02-01T00:00:00.000Z'),
        sessionToken: 'fresh-session-secret',
        user: { displayName: 'Ada', email: 'ada@example.com', id: 'user-id' },
        workspace: { id: 'workspace-id', name: 'My Workspace' },
      };
    });
    const auth = authService({ signIn });
    const app = buildApp({ auth, readiness, webOrigin: 'http://localhost:3000' });
    apps.push(app);

    const response = await app.inject({
      headers: { origin: 'http://localhost:3000' },
      method: 'POST',
      payload: { email: 'ada@example.com', password: 'valid password value' },
      url: '/api/v1/session',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { displayName: 'Ada', email: 'ada@example.com', id: 'user-id' },
      workspace: { id: 'workspace-id', name: 'My Workspace' },
    });
    expect(response.headers['set-cookie']).toContain('openbot_session=fresh-session-secret');
    expect(response.headers['set-cookie']).not.toContain('Secure');
    expect(response.headers['cache-control']).toBe('private, no-store');

    const rejected = await app.inject({
      headers: { origin: 'http://localhost:3000' },
      method: 'POST',
      payload: { email: 'missing@example.com', password: 'valid password value' },
      url: '/api/v1/session',
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: { code: 'invalid_credentials' } });
    expect(rejected.headers['set-cookie']).toBeUndefined();
    expect(rejected.headers['cache-control']).toBe('private, no-store');
  });

  it('returns the current identity only for an authenticated session cookie', async () => {
    const validSessionToken = Buffer.alloc(32, 6).toString('base64url');
    const getSession = vi.fn<AuthService['getSession']>(async (token) =>
      token === validSessionToken
        ? {
            user: { displayName: 'Ada', email: 'ada@example.com', id: 'user-id' },
            workspace: { id: 'workspace-id', name: 'My Workspace' },
          }
        : undefined,
    );
    const app = buildApp({
      auth: authService({ getSession }),
      readiness,
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    const authenticated = await app.inject({
      headers: { cookie: `theme=dark; openbot_session=${validSessionToken}` },
      method: 'GET',
      url: '/api/v1/me',
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toEqual({
      user: { displayName: 'Ada', email: 'ada@example.com', id: 'user-id' },
      workspace: { id: 'workspace-id', name: 'My Workspace' },
    });
    expect(authenticated.headers['cache-control']).toBe('private, no-store');

    for (const cookie of [undefined, 'openbot_session=expired-or-revoked']) {
      const anonymous = await app.inject({
        headers: cookie ? { cookie } : {},
        method: 'GET',
        url: '/api/v1/me',
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toEqual({ error: { code: 'authentication_required' } });
      expect(anonymous.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('rejects cross-site sign-out without consuming the session and securely clears a trusted sign-out', async () => {
    const rawToken = Buffer.alloc(32, 5).toString('base64url');
    let signedOut = false;
    const getSession = vi.fn<AuthService['getSession']>(async (token) =>
      token === rawToken && !signedOut
        ? {
            user: { displayName: 'Ada', email: 'ada@example.com', id: 'user-id' },
            workspace: { id: 'workspace-id', name: 'My Workspace' },
          }
        : undefined,
    );
    const signOut = vi.fn<AuthService['signOut']>(async (token) => {
      signedOut = token === rawToken;
      return signedOut;
    });
    const app = buildApp({
      auth: authService({ getSession, signOut }),
      readiness,
      webOrigin: 'https://openbot.example',
    });
    apps.push(app);

    for (const origin of [
      undefined,
      'null',
      'https://evil.example',
      'https://openbot.example.evil',
    ]) {
      const rejected = await app.inject({
        headers: {
          cookie: `openbot_session=${rawToken}`,
          ...(origin ? { origin } : {}),
        },
        method: 'DELETE',
        url: '/api/v1/session',
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.headers['cache-control']).toBe('private, no-store');
    }
    expect(signOut).not.toHaveBeenCalled();

    const stillAuthenticated = await app.inject({
      headers: { cookie: `openbot_session=${rawToken}` },
      method: 'GET',
      url: '/api/v1/me',
    });
    expect(stillAuthenticated.statusCode).toBe(200);

    const signedOutResponse = await app.inject({
      headers: {
        cookie: `openbot_session=${rawToken}`,
        origin: 'https://openbot.example',
      },
      method: 'DELETE',
      url: '/api/v1/session',
    });
    expect(signedOutResponse.statusCode).toBe(204);
    expect(signedOutResponse.headers['set-cookie']).toContain('openbot_session=');
    expect(signedOutResponse.headers['set-cookie']).toContain('Max-Age=0');
    expect(signedOutResponse.headers['set-cookie']).toContain('HttpOnly');
    expect(signedOutResponse.headers['set-cookie']).toContain('SameSite=Lax');
    expect(signedOutResponse.headers['set-cookie']).toContain('Secure');
    expect(signedOutResponse.headers['cache-control']).toBe('private, no-store');

    const afterSignOut = await app.inject({
      headers: { cookie: `openbot_session=${rawToken}` },
      method: 'GET',
      url: '/api/v1/me',
    });
    expect(afterSignOut.statusCode).toBe(401);
  });

  it('reports whether initial setup is still available without requiring authentication', async () => {
    const isClaimed = vi.fn<AuthService['isClaimed']>().mockResolvedValue(true);
    const app = buildApp({
      auth: authService({ isClaimed }),
      readiness,
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/state' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ claimed: true });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(isClaimed).toHaveBeenCalledOnce();
  });

  it('rejects malformed authentication bodies before they reach the service', async () => {
    const setup = vi.fn<AuthService['setup']>();
    const signIn = vi.fn<AuthService['signIn']>();
    const app = buildApp({
      auth: authService({ setup, signIn }),
      readiness,
      setupTokenDigest,
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    const malformedSetup = await app.inject({
      headers: {
        origin: 'http://localhost:3000',
        'x-openbot-setup-token': setupToken,
      },
      method: 'POST',
      payload: { email: 'ada@example.com', password: 'valid password value' },
      url: '/api/v1/setup',
    });
    const malformedSignIn = await app.inject({
      headers: { origin: 'http://localhost:3000' },
      method: 'POST',
      payload: { email: ['ada@example.com'], password: 'valid password value' },
      url: '/api/v1/session',
    });

    for (const response of [malformedSetup, malformedSignIn]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: 'invalid_request' } });
    }
    expect(setup).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'setup', url: '/api/v1/setup' },
    { method: 'sign-in', url: '/api/v1/session' },
  ])('rejects every untrusted Origin before invoking $method', async ({ url }) => {
    const setup = vi.fn<AuthService['setup']>();
    const signIn = vi.fn<AuthService['signIn']>();
    const app = buildApp({
      auth: authService({ setup, signIn }),
      readiness,
      setupTokenDigest,
      webOrigin: 'https://openbot.example',
    });
    apps.push(app);

    for (const origin of [
      undefined,
      'null',
      'https://evil.example',
      'https://openbot.example.evil',
    ]) {
      const response = await app.inject({
        headers: {
          ...(origin ? { origin } : {}),
          'x-openbot-setup-token': setupToken,
        },
        method: 'POST',
        payload:
          url === '/api/v1/setup'
            ? {
                displayName: 'Attacker',
                email: 'attacker@example.com',
                password: 'attacker password value',
              }
            : { email: 'attacker@example.com', password: 'attacker password value' },
        url,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'invalid_origin' } });
    }
    expect(setup).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('returns a retryable status when password work is at its concurrency bound', async () => {
    const auth = authService({
      signIn: async () => {
        throw new AuthenticationBusyError();
      },
    });
    const app = buildApp({ auth, readiness, webOrigin: 'http://localhost:3000' });
    apps.push(app);

    const response = await app.inject({
      headers: { origin: 'http://localhost:3000' },
      method: 'POST',
      payload: { email: 'ada@example.com', password: 'valid password value' },
      url: '/api/v1/session',
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toEqual({ error: { code: 'authentication_busy' } });
  });

  it('rejects a missing or incorrect operator setup token before invoking password work', async () => {
    const setup = vi.fn<AuthService['setup']>();
    const app = buildApp({
      auth: authService({ setup }),
      readiness,
      setupTokenDigest,
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    for (const token of [undefined, 'incorrect-operator-token-value']) {
      const response = await app.inject({
        headers: {
          origin: 'http://localhost:3000',
          ...(token ? { 'x-openbot-setup-token': token } : {}),
        },
        method: 'POST',
        payload: {
          displayName: 'Attacker',
          email: 'attacker@example.com',
          password: 'attacker password value',
        },
        url: '/api/v1/setup',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'invalid_setup_token' } });
    }
    expect(setup).not.toHaveBeenCalled();
  });

  it('rate-limits one account across source addresses before doing more password work', async () => {
    const authenticationAttempts = new AuthenticationAttemptLimiter({
      accountKeySecret: Buffer.alloc(32, 9),
      accountMaxFailures: 2,
      clientMaxFailures: 20,
    });
    const signIn = vi.fn<AuthService['signIn']>(async () => {
      throw new InvalidCredentialsError();
    });
    const app = buildApp({
      auth: authService({ signIn }),
      authenticationAttempts,
      readiness,
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        headers: { origin: 'http://localhost:3000' },
        method: 'POST',
        payload: {
          email: attempt % 2 === 0 ? ' Known@Example.com ' : 'known@example.com',
          password: 'wrong password value',
        },
        remoteAddress: `192.0.2.${attempt + 1}`,
        url: '/api/v1/session',
      });
      expect(response.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      headers: { origin: 'http://localhost:3000' },
      method: 'POST',
      payload: { email: 'known@example.com', password: 'wrong password value' },
      remoteAddress: '192.0.2.3',
      url: '/api/v1/session',
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('300');
    expect(blocked.json()).toEqual({ error: { code: 'authentication_rate_limited' } });
    expect(blocked.headers['cache-control']).toBe('private, no-store');
    expect(signIn).toHaveBeenCalledTimes(2);

    const otherIdentity = await app.inject({
      headers: { origin: 'http://localhost:3000' },
      method: 'POST',
      payload: { email: 'missing@example.com', password: 'wrong password value' },
      remoteAddress: '192.0.2.3',
      url: '/api/v1/session',
    });
    expect(otherIdentity.statusCode).toBe(401);
    expect(otherIdentity.json()).toEqual({ error: { code: 'invalid_credentials' } });
    expect(signIn).toHaveBeenCalledTimes(3);
  });

  it('uses the socket address for the client bucket and does not trust forwarded addresses', async () => {
    const authenticationAttempts = new AuthenticationAttemptLimiter({
      accountKeySecret: Buffer.alloc(32, 10),
      accountMaxFailures: 10,
      clientMaxFailures: 3,
    });
    const signIn = vi.fn<AuthService['signIn']>(async () => {
      throw new InvalidCredentialsError();
    });
    const app = buildApp({
      auth: authService({ signIn }),
      authenticationAttempts,
      readiness,
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        headers: {
          origin: 'http://localhost:3000',
          'x-forwarded-for': `198.51.100.${attempt + 1}`,
        },
        method: 'POST',
        payload: {
          email: `rotated-${attempt}@example.com`,
          password: 'wrong password value',
        },
        remoteAddress: '192.0.2.50',
        url: '/api/v1/session',
      });
      expect(response.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      headers: {
        origin: 'http://localhost:3000',
        'x-forwarded-for': '198.51.100.200',
      },
      method: 'POST',
      payload: { email: 'fresh@example.com', password: 'wrong password value' },
      remoteAddress: '192.0.2.50',
      url: '/api/v1/session',
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('300');
    expect(signIn).toHaveBeenCalledTimes(3);
  });

  it('clears account failures after sign-in without clearing source abuse history', async () => {
    const authenticationAttempts = new AuthenticationAttemptLimiter({
      accountKeySecret: Buffer.alloc(32, 11),
      accountMaxFailures: 2,
      clientMaxFailures: 3,
    });
    let permitSignIn = false;
    const signIn = vi.fn<AuthService['signIn']>(async ({ email }) => {
      if (!permitSignIn) {
        throw new InvalidCredentialsError();
      }
      return {
        expiresAt: new Date('2030-02-01T00:00:00.000Z'),
        sessionToken: 'fresh-session-secret',
        user: { displayName: 'Ada', email, id: 'user-id' },
        workspace: { id: 'workspace-id', name: 'My Workspace' },
      };
    });
    const app = buildApp({
      auth: authService({ signIn }),
      authenticationAttempts,
      readiness,
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    const request = (email: string, remoteAddress: string) =>
      app.inject({
        headers: { origin: 'http://localhost:3000' },
        method: 'POST',
        payload: { email, password: 'password value' },
        remoteAddress,
        url: '/api/v1/session',
      });

    expect((await request('ada@example.com', '192.0.2.60')).statusCode).toBe(401);
    permitSignIn = true;
    expect((await request('ada@example.com', '192.0.2.60')).statusCode).toBe(200);
    permitSignIn = false;
    expect((await request('ada@example.com', '192.0.2.61')).statusCode).toBe(401);
    expect((await request('ada@example.com', '192.0.2.62')).statusCode).toBe(401);
    expect((await request('ada@example.com', '192.0.2.63')).statusCode).toBe(429);

    expect((await request('other@example.com', '192.0.2.60')).statusCode).toBe(401);
    expect((await request('third@example.com', '192.0.2.60')).statusCode).toBe(401);
    expect((await request('fourth@example.com', '192.0.2.60')).statusCode).toBe(429);
  });
});

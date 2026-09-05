import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { oidcFixture } from '../helpers/oidc-fixture.js';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
});
it('reports OIDC disabled without adding OIDC actions when unconfigured', async () => {
  const app = buildApp({
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  close.push(() => app.close());
  const result = await app.inject({ url: '/api/v1/oidc' });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual({ enabled: false });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/oidc/start',
        payload: { purpose: 'signin' },
      })
    ).statusCode,
  ).toBe(404);
});

it('runs configured OIDC through HTTP cookies, rejects CSRF, and provides authenticated identity settings', async () => {
  const { auth, oidc, owner, idp } = await oidcFixture(close);
  const app = buildApp({
    auth,
    oidc,
    webOrigin: 'http://127.0.0.1:4173',
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  close.push(() => app.close());
  const headers = {
    origin: 'http://127.0.0.1:4173',
    cookie: `openbot_session=${owner.sessionToken}`,
  };
  expect((await app.inject({ url: '/api/v1/oidc' })).json()).toEqual({ enabled: true });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/oidc/start',
        payload: { purpose: 'link' },
        headers: { ...headers, origin: 'https://evil.example' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/oidc/start',
        payload: { purpose: 'link' },
        headers: { origin: headers.origin },
      })
    ).statusCode,
  ).toBe(401);
  const start = await app.inject({
    method: 'POST',
    url: '/api/v1/oidc/start',
    payload: { purpose: 'link' },
    headers,
  });
  expect(start.statusCode).toBe(200);
  expect(start.headers['cache-control']).toBe('private, no-store');
  expect(start.headers['referrer-policy']).toBe('no-referrer');
  const browserCookie = String(start.headers['set-cookie']);
  expect(browserCookie).toContain('Path=/auth/oidc');
  expect(browserCookie).toContain('HttpOnly');
  const callbackUrl = idp.issue(start.json().authorizationUrl);
  const callback = await app.inject({
    method: 'POST',
    url: '/api/v1/oidc/callback',
    payload: { callbackUrl },
    headers: { ...headers, cookie: headers.cookie + '; ' + browserCookie.split(';')[0] },
  });
  expect(callback.statusCode).toBe(200);
  expect(callback.json()).toEqual({ destination: '/app/security' });
  expect(callback.body).not.toContain(new URL(callbackUrl).searchParams.get('code'));
  expect((await app.inject({ url: '/api/v1/oidc/identity', headers })).json()).toEqual({
    linked: true,
    canUnlink: true,
  });
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/v1/oidc/identity',
        headers: { ...headers, origin: 'https://evil.example' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/v1/oidc/identity', headers })).statusCode,
  ).toBe(204);
});

it('omits callback query values and credentials from request logs', async () => {
  const source = `
    import {buildApp} from './src/app.ts';
    const app=buildApp({logger:true,readiness:{check:async()=>({database:'ready',migrations:'current'})}});
    await app.inject({url:'/api/v1/oidc?code=private-authorization-code&state=private-browser-state',headers:{cookie:'openbot_oidc=private-browser-cookie'}});
    await app.close();
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    source,
  ]);
  expect(stdout).toContain('/api/v1/oidc');
  expect(stdout + stderr).not.toMatch(
    /private-authorization-code|private-browser-state|private-browser-cookie/u,
  );
});

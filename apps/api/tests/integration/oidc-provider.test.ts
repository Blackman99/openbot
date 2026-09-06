import { afterEach, expect, it } from 'vitest';
import { OpenIdProvider } from '../../src/oidc/provider.js';
import { startMockIdp } from '../helpers/mock-idp.js';
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
});
it('uses code/S256 PKCE and redeems a signed ID token against exact state and nonce', async () => {
  const idp = await startMockIdp();
  close.push(idp.close);
  const provider = new OpenIdProvider({
    issuer: idp.issuer,
    clientId: 'openbot',
    clientSecret: 'test-secret',
    callbackUrl: 'http://127.0.0.1:4173/auth/oidc/callback',
    allowLoopbackHttp: true,
  });
  const proof = { state: 'test-state', nonce: 'test-nonce', verifier: 'a'.repeat(43) };
  const authorization = await provider.authorize(proof);
  expect(new URL(authorization).searchParams.get('code_challenge_method')).toBe('S256');
  expect(await provider.redeem(idp.issue(authorization), proof)).toEqual({
    issuer: idp.issuer,
    subject: 'ada-subject',
    email: 'ada@example.com',
    emailVerified: true,
    displayName: 'Ada',
  });
});
it.each([
  ['nonce', { nonce: 'wrong-nonce' }],
  ['issuer', { iss: 'https://other.example' }],
  ['audience', { aud: 'other-client' }],
  ['expiry', { exp: 1 }],
])('rejects a signed ID token with an invalid %s', async (_kind, claims) => {
  const idp = await startMockIdp();
  close.push(idp.close);
  const provider = new OpenIdProvider({
    issuer: idp.issuer,
    clientId: 'openbot',
    clientSecret: 'test-secret',
    callbackUrl: 'http://127.0.0.1:4173/auth/oidc/callback',
    allowLoopbackHttp: true,
  });
  const proof = { state: 'test-state', nonce: 'test-nonce', verifier: 'a'.repeat(43) };
  await expect(
    provider.redeem(idp.issue(await provider.authorize(proof), claims), proof),
  ).rejects.toThrow();
});
it('rejects bad signatures, invalid state, incorrect PKCE, duplicate parameters and code replay', async () => {
  const idp = await startMockIdp();
  close.push(idp.close);
  const provider = new OpenIdProvider({
    issuer: idp.issuer,
    clientId: 'openbot',
    clientSecret: 'test-secret',
    callbackUrl: 'http://127.0.0.1:4173/auth/oidc/callback',
    allowLoopbackHttp: true,
  });
  const proof = { state: 'test-state', nonce: 'test-nonce', verifier: 'a'.repeat(43) };
  const authorization = await provider.authorize(proof);
  await expect(
    provider.redeem(idp.issue(authorization), { ...proof, state: 'other-state' }),
  ).rejects.toThrow();
  await expect(
    provider.redeem(idp.issue(authorization), { ...proof, verifier: 'b'.repeat(43) }),
  ).rejects.toThrow();
  await expect(
    provider.redeem(idp.issue(authorization) + '&state=duplicate', proof),
  ).rejects.toThrow();
  const callback = idp.issue(authorization);
  await provider.redeem(callback, proof);
  await expect(provider.redeem(callback, proof)).rejects.toThrow();
  idp.breakSignature();
  await expect(provider.redeem(idp.issue(authorization), proof)).rejects.toThrow();
});

it('keeps the test HTTP exception restricted to loopback authorization endpoints', async () => {
  const idp = await startMockIdp({ authorization_endpoint: 'http://outside.example/authorize' });
  close.push(idp.close);
  const provider = new OpenIdProvider({
    issuer: idp.issuer,
    clientId: 'openbot',
    clientSecret: 'test-secret',
    callbackUrl: 'http://127.0.0.1:4173/auth/oidc/callback',
    allowLoopbackHttp: true,
  });
  await expect(
    provider.authorize({ state: 'state', nonce: 'nonce', verifier: 'a'.repeat(43) }),
  ).rejects.toThrow();
});

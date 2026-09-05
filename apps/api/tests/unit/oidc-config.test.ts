import { describe, expect, it } from 'vitest';
import { readApiConfig } from '../../src/config.js';
const base = {
  DATABASE_URL: 'postgres://user:pass@localhost/openbot',
  OPENBOT_SETUP_TOKEN: 'a'.repeat(32),
  WEB_ORIGIN: 'https://openbot.example',
};
describe('optional OIDC configuration', () => {
  it('leaves OIDC disabled unless a complete trusted provider is configured', () => {
    expect(readApiConfig(base)).not.toHaveProperty('oidc');
    expect(
      readApiConfig({ ...base, OIDC_ISSUER_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '' }),
    ).not.toHaveProperty('oidc');
    expect(
      readApiConfig({
        ...base,
        OIDC_ISSUER_URL: 'https://id.example',
        OIDC_CLIENT_ID: 'openbot',
        OIDC_CLIENT_SECRET: 'secret',
      }),
    ).toHaveProperty('oidc', {
      issuer: 'https://id.example',
      clientId: 'openbot',
      clientSecret: 'secret',
      callbackUrl: 'https://openbot.example/auth/oidc/callback',
      allowLoopbackHttp: false,
    });
  });
  it.each([
    { OIDC_CLIENT_ID: 'openbot' },
    { OIDC_ISSUER_URL: 'https://id.example', OIDC_CLIENT_ID: 'openbot' },
    {
      OIDC_ISSUER_URL: 'http://id.example',
      OIDC_CLIENT_ID: 'openbot',
      OIDC_CLIENT_SECRET: 'secret',
    },
    {
      OIDC_ISSUER_URL: 'https://user:secret@id.example',
      OIDC_CLIENT_ID: 'openbot',
      OIDC_CLIENT_SECRET: 'secret',
    },
    {
      OIDC_ISSUER_URL: 'http://127.0.0.1:4999',
      OIDC_CLIENT_ID: 'openbot',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOW_LOOPBACK_HTTP: 'true',
    },
  ])('rejects incomplete or unsafe OIDC configuration: %j', (oidc) => {
    expect(() => readApiConfig({ ...base, ...oidc })).toThrow(/OIDC/u);
  });
});

it('allows HTTP only for the explicit loopback test provider and loopback browser origin', () => {
  const config = readApiConfig({
    ...base,
    WEB_ORIGIN: 'http://127.0.0.1:4173',
    NODE_ENV: 'test',
    OIDC_ISSUER_URL: 'http://127.0.0.1:4999',
    OIDC_CLIENT_ID: 'openbot',
    OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_ALLOW_LOOPBACK_HTTP: 'true',
  });
  expect(config.oidc?.allowLoopbackHttp).toBe(true);
});

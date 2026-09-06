import { describe, expect, it } from 'vitest';

import { readApiConfig } from '../../src/config.js';

describe('readApiConfig', () => {
  it('builds the runtime configuration from the documented environment', () => {
    expect(
      readApiConfig({
        API_HOST: '127.0.0.1',
        API_PORT: '4310',
        DATABASE_CONNECTION_TIMEOUT_MS: '250',
        DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
        OPENBOT_SETUP_TOKEN: 'local-only-openbot-setup-token-change-me',
        WEB_ORIGIN: 'http://localhost:4173',
      }),
    ).toEqual({
      attachmentMaxBytes: 10485760,
      database: {
        connectionString: 'postgresql://openbot:openbot@localhost:5432/openbot',
      },
      objectStorage: { backend: 'local', rootDirectory: '/var/lib/openbot/objects' },
      databaseConnectionTimeoutMs: 250,
      databaseQueryTimeoutMs: 1_000,
      host: '127.0.0.1',
      port: 4310,
      setupTokenDigest: '4b5d9e48b8fbcf6584a8919aec8686de5a09e4a6310a8488c83a442e8bb88b7e',
      webOrigin: 'http://localhost:4173',
    });
  });

  it('supports discrete PostgreSQL settings without interpolating credentials into a URL', () => {
    expect(
      readApiConfig({
        PGDATABASE: 'openbot',
        PGHOST: 'postgres',
        PGPASSWORD: 'reserved:/?#[]@!$&',
        PGPORT: '5433',
        PGUSER: 'openbot',
        OPENBOT_SETUP_TOKEN: 'local-only-openbot-setup-token-change-me',
      }).database,
    ).toEqual({
      database: 'openbot',
      host: 'postgres',
      password: 'reserved:/?#[]@!$&',
      port: 5433,
      user: 'openbot',
    });
  });

  it('rejects startup without a complete database configuration', () => {
    expect(() => readApiConfig({})).toThrowError(
      'DATABASE_URL or PGHOST, PGUSER, PGPASSWORD, and PGDATABASE is required',
    );
  });

  it.each([
    ['API_PORT', '0'],
    ['API_PORT', '65536'],
    ['API_PORT', '12.5'],
    ['API_PORT', 'not-a-number'],
    ['DATABASE_CONNECTION_TIMEOUT_MS', '0'],
    ['DATABASE_QUERY_TIMEOUT_MS', 'Infinity'],
  ])('rejects invalid integer setting %s=%s', (name, value) => {
    expect(() =>
      readApiConfig({
        DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
        [name]: value,
      }),
    ).toThrowError(`${name} must be an integer`);
  });

  it('rejects an invalid discrete PostgreSQL port', () => {
    expect(() =>
      readApiConfig({
        PGDATABASE: 'openbot',
        PGHOST: 'postgres',
        PGPASSWORD: 'secret',
        PGPORT: '-1',
        PGUSER: 'openbot',
      }),
    ).toThrowError('PGPORT must be an integer');
  });

  it.each([
    ['DATABASE_URL', 'not-a-url'],
    ['DATABASE_URL', 'https://database.example/openbot'],
    ['WEB_ORIGIN', 'not-a-url'],
    ['WEB_ORIGIN', 'ftp://web.example'],
    ['WEB_ORIGIN', 'https://web.example/path'],
  ])('rejects invalid URL setting %s=%s', (name, value) => {
    expect(() =>
      readApiConfig({
        DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
        [name]: value,
      }),
    ).toThrowError(`${name} must be a valid`);
  });

  it('requires HTTPS for every non-loopback browser origin', () => {
    expect(() =>
      readApiConfig({
        DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
        WEB_ORIGIN: 'http://openbot.example',
      }),
    ).toThrowError('WEB_ORIGIN must use HTTPS unless it is loopback');

    expect(
      readApiConfig({
        DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
        OPENBOT_SETUP_TOKEN: 'local-only-openbot-setup-token-change-me',
        WEB_ORIGIN: 'http://127.0.0.1:4173',
      }).webOrigin,
    ).toBe('http://127.0.0.1:4173');
  });

  it('distinguishes a malformed loopback URL from an insecure remote origin', () => {
    expect(() =>
      readApiConfig({
        DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
        WEB_ORIGIN: 'http://localhost:3000/path',
      }),
    ).toThrowError('WEB_ORIGIN must be a valid HTTP(S) origin');
  });

  it('requires a high-entropy operator token and retains only its digest', () => {
    for (const setupToken of [undefined, 'too-short']) {
      expect(() =>
        readApiConfig({
          DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
          OPENBOT_SETUP_TOKEN: setupToken,
        }),
      ).toThrowError('OPENBOT_SETUP_TOKEN must be between 32 and 1024 bytes');
    }
  });

  it('rejects the documented local setup token for a non-loopback deployment', () => {
    expect(() =>
      readApiConfig({
        DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
        OPENBOT_SETUP_TOKEN: 'local-only-openbot-setup-token-change-me',
        WEB_ORIGIN: 'https://openbot.example',
      }),
    ).toThrowError(
      'OPENBOT_SETUP_TOKEN must not use the documented local-development value for a non-loopback WEB_ORIGIN',
    );
  });

  it('allows the documented local setup token for loopback development', () => {
    expect(
      readApiConfig({
        DATABASE_URL: 'postgresql://openbot:openbot@localhost:5432/openbot',
        OPENBOT_SETUP_TOKEN: 'local-only-openbot-setup-token-change-me',
        WEB_ORIGIN: 'http://[::1]:3000',
      }).webOrigin,
    ).toBe('http://[::1]:3000');
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { buildProductionApp } from '../../src/runtime.js';

describe('production status composition', () => {
  const apps: Array<Awaited<ReturnType<typeof buildProductionApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('keeps the API responsive when PostgreSQL is unavailable', async () => {
    const app = await buildProductionApp({
      database: {
        connectionString: 'postgresql://openbot:openbot@127.0.0.1:1/openbot',
      },
      databaseConnectionTimeoutMs: 100,
      databaseQueryTimeoutMs: 100,
      logger: false,
      setupTokenDigest: '4b5d9e48b8fbcf6584a8919aec8686de5a09e4a6310a8488c83a442e8bb88b7e',
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/status' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      status: 'unavailable',
      checks: {
        database: 'unavailable',
        migrations: 'unknown',
      },
    });
  });

  it('allows credentials only for the configured browser origin', async () => {
    const app = await buildProductionApp({
      database: {
        connectionString: 'postgresql://openbot:openbot@127.0.0.1:1/openbot',
      },
      databaseConnectionTimeoutMs: 100,
      databaseQueryTimeoutMs: 100,
      logger: false,
      setupTokenDigest: '4b5d9e48b8fbcf6584a8919aec8686de5a09e4a6310a8488c83a442e8bb88b7e',
      webOrigin: 'https://openbot.example',
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        'access-control-request-headers': 'content-type,x-openbot-setup-token',
        'access-control-request-method': 'POST',
        origin: 'https://openbot.example',
      },
      method: 'OPTIONS',
      url: '/api/v1/setup',
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://openbot.example');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
    expect(response.headers['access-control-allow-headers']?.toLowerCase()).toContain(
      'x-openbot-setup-token',
    );

    const deleteResponse = await app.inject({
      headers: {
        'access-control-request-method': 'DELETE',
        origin: 'https://openbot.example',
      },
      method: 'OPTIONS',
      url: '/api/v1/session',
    });
    expect(deleteResponse.statusCode).toBe(204);
    expect(deleteResponse.headers['access-control-allow-methods']).toContain('DELETE');

    const untrustedResponse = await app.inject({
      headers: {
        'access-control-request-method': 'POST',
        origin: 'https://attacker.example',
      },
      method: 'OPTIONS',
      url: '/api/v1/session',
    });
    expect(untrustedResponse.headers['access-control-allow-origin']).toBeUndefined();
    expect(untrustedResponse.headers['access-control-allow-credentials']).toBeUndefined();

    const untrustedActualResponse = await app.inject({
      headers: { origin: 'https://attacker.example' },
      method: 'GET',
      url: '/api/v1/me',
    });
    expect(untrustedActualResponse.headers['access-control-allow-origin']).toBeUndefined();
    expect(untrustedActualResponse.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('composes the local authentication routes in the production application', async () => {
    const app = await buildProductionApp({
      database: {
        connectionString: 'postgresql://openbot:openbot@127.0.0.1:1/openbot',
      },
      databaseConnectionTimeoutMs: 100,
      databaseQueryTimeoutMs: 100,
      logger: false,
      setupTokenDigest: '4b5d9e48b8fbcf6584a8919aec8686de5a09e4a6310a8488c83a442e8bb88b7e',
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: 'authentication_required' } });
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import type { ReadinessProbe } from '../../src/readiness.js';

describe('GET /api/v1/status', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns the stable versioned ready payload when all checks pass', async () => {
    const readiness: ReadinessProbe = {
      check: async () => ({ database: 'ready', migrations: 'current' }),
    };
    const app = buildApp({ readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      status: 'ready',
      checks: {
        database: 'ready',
        migrations: 'current',
      },
    });
  });

  it('returns unavailable when the database cannot be reached', async () => {
    const readiness: ReadinessProbe = {
      check: async () => ({ database: 'unavailable', migrations: 'unknown' }),
    };
    const app = buildApp({ readiness });
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

  it('returns unavailable when database migrations are stale', async () => {
    const readiness: ReadinessProbe = {
      check: async () => ({ database: 'ready', migrations: 'stale' }),
    };
    const app = buildApp({ readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/status' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      status: 'unavailable',
      checks: {
        database: 'ready',
        migrations: 'stale',
      },
    });
  });

  it('fails closed when migration state is unknown', async () => {
    const readiness: ReadinessProbe = {
      check: async () => ({ database: 'ready', migrations: 'unknown' }),
    };
    const app = buildApp({ readiness });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/status' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      status: 'unavailable',
      checks: {
        database: 'ready',
        migrations: 'unknown',
      },
    });
  });
});

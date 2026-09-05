import { describe, expect, it, vi } from 'vitest';

import { fetchStatus } from '../../src/lib/server/status.js';

describe('fetchStatus', () => {
  it('loads the Ready state from the configured live API', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        schemaVersion: 1,
        status: 'ready',
        checks: { database: 'ready', migrations: 'current' },
      }),
    );

    await expect(fetchStatus(request, 'http://api.internal:3001')).resolves.toEqual({
      status: 'ready',
    });
    expect(request).toHaveBeenCalledWith(
      'http://api.internal:3001/api/v1/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('maps an API 503 response to Unavailable', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          schemaVersion: 1,
          status: 'unavailable',
          checks: { database: 'ready', migrations: 'stale' },
        },
        { status: 503 },
      ),
    );

    await expect(fetchStatus(request, 'http://api.internal:3001')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('fails closed when a successful response does not match the versioned contract', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        schemaVersion: 2,
        status: 'ready',
        checks: { database: 'ready', migrations: 'current' },
      }),
    );

    await expect(fetchStatus(request, 'http://api.internal:3001')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('fails closed when the API reports unavailable with a successful HTTP status', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        schemaVersion: 1,
        status: 'unavailable',
        checks: { database: 'ready', migrations: 'stale' },
      }),
    );

    await expect(fetchStatus(request, 'http://api.internal:3001')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('sends an abort signal so an unresponsive API cannot hold the page indefinitely', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        schemaVersion: 1,
        status: 'ready',
        checks: { database: 'ready', migrations: 'current' },
      }),
    );

    await fetchStatus(request, 'http://api.internal:3001');

    expect(request).toHaveBeenCalledWith(
      'http://api.internal:3001/api/v1/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('maps a network failure to Unavailable without exposing the upstream error', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('connect ECONNREFUSED api.internal');
    });

    await expect(fetchStatus(request, 'http://api.internal:3001')).resolves.toEqual({
      status: 'unavailable',
    });
  });
});

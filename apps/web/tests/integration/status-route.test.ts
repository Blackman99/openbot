import { afterEach, describe, expect, it, vi } from 'vitest';

import { load } from '../../src/routes/+page.server.js';

describe('status page server route', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads page state from API_BASE_URL', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api.internal:3001');
    const request = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        schemaVersion: 1,
        status: 'ready',
        checks: { database: 'ready', migrations: 'current' },
      }),
    );

    await expect(load({ fetch: request })).resolves.toEqual({ status: 'ready' });
    expect(request).toHaveBeenCalledWith(
      'http://api.internal:3001/api/v1/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

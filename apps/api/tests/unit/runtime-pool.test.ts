import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolDouble = vi.hoisted(() => ({
  end: vi.fn(async () => undefined),
  errorListeners: [] as Array<(error: Error) => void>,
  on: vi.fn((event: string, listener: (error: Error) => void) => {
    if (event === 'error') {
      poolDouble.errorListeners.push(listener);
    }
  }),
  query: vi.fn(async () => ({ rows: [] })),
}));

vi.mock('pg', () => ({
  default: {
    Pool: class {
      readonly end = poolDouble.end;
      readonly on = poolDouble.on;
      readonly query = poolDouble.query;
    },
  },
}));

import { buildProductionApp } from '../../src/runtime.js';

describe('production PostgreSQL pool', () => {
  beforeEach(() => {
    poolDouble.errorListeners.length = 0;
    vi.clearAllMocks();
  });

  it('handles idle connection errors so a database outage cannot terminate the API', async () => {
    const app = buildProductionApp({
      database: { connectionString: 'postgresql://openbot:secret@postgres/openbot' },
      databaseConnectionTimeoutMs: 100,
      databaseQueryTimeoutMs: 100,
      logger: false,
      setupTokenDigest: '4b5d9e48b8fbcf6584a8919aec8686de5a09e4a6310a8488c83a442e8bb88b7e',
      webOrigin: 'http://localhost:3000',
    });

    expect(poolDouble.errorListeners).toHaveLength(1);
    expect(() => poolDouble.errorListeners[0]?.(new Error('database stopped'))).not.toThrow();

    await app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(poolDouble.query).toHaveBeenCalledWith(
      'SELECT version FROM openbot_schema_migrations ORDER BY applied_at, version',
      undefined,
    );

    await app.close();
  });
});

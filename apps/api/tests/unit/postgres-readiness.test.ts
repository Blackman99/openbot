import { describe, expect, it, vi } from 'vitest';

import { PostgresReadinessProbe, type DatabaseClient } from '../../src/database/readiness.js';

describe('PostgresReadinessProbe', () => {
  it('reports an unavailable database without exposing connection details', async () => {
    const database: DatabaseClient = {
      query: async () => {
        throw new Error('connect ECONNREFUSED postgresql://user:secret@database/openbot');
      },
    };
    const probe = new PostgresReadinessProbe(database, ['0001_bootstrap']);

    await expect(probe.check()).resolves.toEqual({
      database: 'unavailable',
      migrations: 'unknown',
    });
  });

  it('reports stale migrations when the migration ledger has no current version', async () => {
    const database: DatabaseClient = {
      query: async () => ({ rows: [] }),
    };
    const probe = new PostgresReadinessProbe(database, ['0001_bootstrap']);

    await expect(probe.check()).resolves.toEqual({
      database: 'ready',
      migrations: 'stale',
    });
  });

  it.each([
    {
      applied: ['0002_local_owner_auth'],
      description: 'the current migration without its predecessor',
    },
    {
      applied: ['0001_bootstrap', '0002_local_owner_auth', '9999_future_migration'],
      description: 'an unknown migration after the current version',
    },
    {
      applied: ['0002_local_owner_auth', '0001_bootstrap'],
      description: 'known migrations in the wrong order',
    },
  ])('reports stale migrations for $description', async ({ applied }) => {
    const database: DatabaseClient = {
      query: vi
        .fn<DatabaseClient['query']>()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: applied.map((version) => ({ version })) }),
    };
    const probe = new PostgresReadinessProbe(database, ['0001_bootstrap', '0002_local_owner_auth']);

    await expect(probe.check()).resolves.toEqual({
      database: 'ready',
      migrations: 'stale',
    });
  });

  it('requires the complete ordered migration ledger', async () => {
    const database: DatabaseClient = {
      query: vi
        .fn<DatabaseClient['query']>()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({
          rows: [{ version: '0001_bootstrap' }, { version: '0002_local_owner_auth' }],
        }),
    };
    const probe = new PostgresReadinessProbe(database, ['0001_bootstrap', '0002_local_owner_auth']);

    await expect(probe.check()).resolves.toEqual({
      database: 'ready',
      migrations: 'current',
    });
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      'SELECT version FROM openbot_schema_migrations ORDER BY applied_at, version',
    );
  });

  it('reports stale migrations when a reachable database has no migration ledger', async () => {
    let databaseWasPinged = false;
    const database: DatabaseClient = {
      query: async () => {
        if (!databaseWasPinged) {
          databaseWasPinged = true;
          return { rows: [] };
        }

        throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      },
    };
    const probe = new PostgresReadinessProbe(database, ['0001_bootstrap']);

    await expect(probe.check()).resolves.toEqual({
      database: 'ready',
      migrations: 'stale',
    });
  });
});

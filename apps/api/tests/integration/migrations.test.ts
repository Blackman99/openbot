import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MIGRATION_VERSIONS,
  migrateDatabase,
  POSTGRES_AUDIT_APPEND_ONLY_STATEMENTS,
} from '../../src/database/migrations.js';
import {
  PostgresReadinessProbe,
  type DatabaseClient,
  type DatabaseQueryResult,
} from '../../src/database/readiness.js';

describe('database migrations', () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('records ordered immutable migrations and makes readiness current', async () => {
    const memoryDatabase = newDb({ noAstCoverageCheck: true });
    const adapter = memoryDatabase.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    await migrateDatabase(pool, { installPostgresGuards: false });
    await migrateDatabase(pool, { installPostgresGuards: false });

    const migrations = (await pool.query(`
      SELECT version
      FROM openbot_schema_migrations
      ORDER BY applied_at, version
    `)) as { rows: Array<{ version: string }> };
    expect(migrations.rows.map(({ version }) => version)).toEqual([
      '0001_bootstrap',
      '0002_local_owner_auth',
      '0003_workspace_settings',
      '0004_personal_model_connections',
      '0005_workspace_invitations',
      '0006_workspace_member_provenance',
      '0007_oidc',
      '0008_workspace_model_connections',
      '0009_groups_and_human_memberships',
      '0010_scoped_api_tokens',
    ]);

    const database: DatabaseClient = {
      query: async <Row extends Record<string, unknown>>(
        statement: string,
        parameters?: unknown[],
      ): Promise<DatabaseQueryResult<Row>> => {
        const result = await pool.query(statement, parameters);
        return { rows: result.rows as Row[] };
      },
    };
    const readiness = new PostgresReadinessProbe(database, MIGRATION_VERSIONS);

    await expect(readiness.check()).resolves.toEqual({
      database: 'ready',
      migrations: 'current',
    });
  });

  it('creates the local-owner authentication schema without storing credentials on users', async () => {
    const memoryDatabase = newDb({ noAstCoverageCheck: true });
    const adapter = memoryDatabase.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    await migrateDatabase(pool, { installPostgresGuards: false });

    const tables = (await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `)) as { rows: Array<{ table_name: string }> };
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      'api_tokens',
      'audit_events',
      'group_memberships',
      'groups',
      'instance_claims',
      'local_credentials',
      'oidc_identities',
      'oidc_transactions',
      'openbot_schema_migrations',
      'personal_model_connections',
      'sessions',
      'users',
      'workspace_invitations',
      'workspace_memberships',
      'workspace_model_connections',
      'workspaces',
    ]);

    const userColumns = (await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
      ORDER BY column_name
    `)) as { rows: Array<{ column_name: string }> };
    expect(userColumns.rows.map(({ column_name }) => column_name)).not.toContain('password_hash');

    await expect(
      pool.query('SELECT version FROM openbot_schema_migrations ORDER BY version DESC LIMIT 1'),
    ).resolves.toMatchObject({ rows: [{ version: '0010_scoped_api_tokens' }] });
  });

  it('serializes real PostgreSQL migrators before inspecting the ledger', async () => {
    const calls: Array<{ parameters?: unknown[]; statement: string }> = [];
    const connection = {
      query: async (statement: string, parameters?: unknown[]) => {
        calls.push({ statement, ...(parameters === undefined ? {} : { parameters }) });
        return { rows: [] };
      },
      release: () => undefined,
    };

    await migrateDatabase({ connect: async () => connection });

    expect(calls.slice(0, 3)).toEqual([
      { statement: 'BEGIN' },
      {
        statement: 'SELECT pg_advisory_xact_lock(hashtext($1))',
        parameters: ['openbot:schema-migrations'],
      },
      {
        statement: expect.stringContaining(
          'CREATE TABLE IF NOT EXISTS openbot_schema_migrations',
        ) as string,
      },
    ]);
  });

  it('does not replay schema statements for versions already in the ledger', async () => {
    const statements: string[] = [];
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? {
              rows: MIGRATION_VERSIONS.map((version) => ({ version })),
            }
          : { rows: [] };
      },
      release: () => undefined,
    };

    await migrateDatabase({ connect: async () => connection }, { installPostgresGuards: false });

    expect(statements).toEqual([
      'BEGIN',
      expect.stringContaining('CREATE TABLE IF NOT EXISTS openbot_schema_migrations') as string,
      'SELECT version FROM openbot_schema_migrations ORDER BY applied_at, version',
      'COMMIT',
    ]);
  });

  it.each([
    {
      description: 'a missing predecessor',
      rows: [{ version: '0002_local_owner_auth' }],
    },
    {
      description: 'an unknown future version',
      rows: [{ version: '0001_bootstrap' }, { version: '9999_unknown' }],
    },
    {
      description: 'a non-prefix order',
      rows: [{ version: '0002_local_owner_auth' }, { version: '0001_bootstrap' }],
    },
  ])('rejects and rolls back $description in the migration ledger', async ({ rows }) => {
    const statements: string[] = [];
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? { rows }
          : { rows: [] };
      },
      release: () => undefined,
    };

    await expect(
      migrateDatabase({ connect: async () => connection }, { installPostgresGuards: false }),
    ).rejects.toThrow('Migration ledger is not an ordered prefix of known migrations');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(statements.join('\n')).not.toContain('CREATE TABLE IF NOT EXISTS users');
  });

  it('installs a statement-level audit guard that also rejects truncation', () => {
    const guard = POSTGRES_AUDIT_APPEND_ONLY_STATEMENTS.join('\n');

    expect(guard).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events');
    expect(guard).toContain('FOR EACH STATEMENT');
  });
  it('rejects an unknown historical target before connecting to the database', async () => {
    let connections = 0;
    const pool = {
      connect: async () => {
        connections++;
        throw new Error('Unexpected database connection');
      },
    };
    await expect(migrateDatabase(pool, { throughVersion: '9999_unknown' })).rejects.toThrow(
      'Unknown migration target',
    );
    expect(connections).toBe(0);
  });
  it('rejects a historical target older than the existing ledger without changing it', async () => {
    const database = newDb({ noAstCoverageCheck: true });
    const pool = new (database.adapters.createPg().Pool)();
    pools.push(pool);
    await migrateDatabase(pool, { installPostgresGuards: false });
    const before = (
      await pool.query('SELECT version FROM openbot_schema_migrations ORDER BY version')
    ).rows;
    await expect(
      migrateDatabase(pool, {
        installPostgresGuards: false,
        throughVersion: '0005_workspace_invitations',
      }),
    ).rejects.toThrow('Database is newer than the requested migration target');
    expect(
      (await pool.query('SELECT version FROM openbot_schema_migrations ORDER BY version')).rows,
    ).toEqual(before);
  });
  it('backfills exact invitation provenance for memberships created before migration 0006', async () => {
    const database = newDb({ noAstCoverageCheck: true });
    const pool = new (database.adapters.createPg().Pool)();
    pools.push(pool);
    await migrateDatabase(pool, {
      installPostgresGuards: false,
      throughVersion: '0005_workspace_invitations',
    });
    expect(
      (
        await pool.query(
          'SELECT version FROM openbot_schema_migrations ORDER BY version DESC LIMIT 1',
        )
      ).rows,
    ).toEqual([{ version: '0005_workspace_invitations' }]);
    const ownerId = '00000000-0000-4000-8000-000000000001';
    const userId = '00000000-0000-4000-8000-000000000002';
    const workspaceId = '00000000-0000-4000-8000-000000000003';
    const invitationId = '00000000-0000-4000-8000-000000000004';
    const now = new Date('2030-01-01');
    for (const [id, email] of [
      [ownerId, 'owner@example.com'],
      [userId, 'member@example.com'],
    ])
      await pool.query(
        'INSERT INTO users (id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$2,$3)',
        [id, email, now],
      );
    await pool.query('INSERT INTO workspaces (id,name,created_at) VALUES ($1,$2,$3)', [
      workspaceId,
      'Legacy',
      now,
    ]);
    await pool.query(
      "INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,'member',$3)",
      [workspaceId, userId, now],
    );
    await pool.query(
      "INSERT INTO workspace_invitations (id,workspace_id,email,role,token_digest,created_by_user_id,created_at,expires_at,consumed_at,consumed_by_user_id) VALUES ($1,$2,'member@example.com','member',$3,$4,$5,$6,$5,$7)",
      [invitationId, workspaceId, 'a'.repeat(64), ownerId, now, new Date('2030-01-02'), userId],
    );
    await migrateDatabase(pool, { installPostgresGuards: false });
    expect(
      (
        await pool.query(
          'SELECT invitation_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
          [workspaceId, userId],
        )
      ).rows,
    ).toEqual([{ invitation_id: invitationId }]);
  });
});

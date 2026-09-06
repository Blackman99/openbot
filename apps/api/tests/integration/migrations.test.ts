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
      '0011_model_capability_policies',
      '0012_bot_identity',
      '0013_bot_avatar_objects',
      '0014_conversation_ledger',
      '0015_group_bot_grants',
      '0016_bot_lifecycle',
      '0017_single_bot_tasks',
      '0018_conversation_attachments',
      '0019_conversation_delivery',
      '0020_group_source_memories',
      '0021_deterministic_group_routing',
      '0022_failed_task_retries',
      '0023_task_tree_cancellation',
      '0024_bot_private_memories',
      '0025_memory_extraction_jobs',
      '0026_memory_candidates',
      '0027_memory_candidate_review',
      '0028_scoped_knowledge',
      '0029_run_knowledge_references',
      '0030_knowledge_full_text_search',
      '0031_memory_revisions_and_revocations',
      '0032_document_knowledge_locators',
      '0033_task_pause_checkpoints',
      '0034_task_resume_commands',
      '0035_task_run_recovery',
      '0036_task_execution_limit_snapshots',
      '0037_task_execution_limit_enforcement',
      '0038_task_run_concurrency_holds',
      '0039_group_imported_routines',
      '0040_task_delegation',
      '0041_task_token_usage',
      '0042_task_token_budgets',
      '0043_task_parallel_delegations',
      '0044_task_lead_handoffs',
      '0045_model_price_versions',
      '0046_task_cost_budgets',
      '0047_task_human_requests',
      '0048_task_cost_grants',
      '0049_group_archive',
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
      'approved_memory_facts',
      'attachment_objects',
      'audit_events',
      'avatar_objects',
      'bot_acl',
      'bot_avatar_references',
      'bot_private_memories',
      'bot_versions',
      'bots',
      'conversation_delivery_events',
      'conversation_delivery_state',
      'conversation_events',
      'conversations',
      'group_bot_grants',
      'group_imported_routines',
      'group_memberships',
      'group_memories',
      'group_routing_settings',
      'groups',
      'instance_claims',
      'knowledge_chunks',
      'knowledge_documents',
      'local_credentials',
      'memory_candidate_decisions',
      'memory_candidate_review_confirmations',
      'memory_candidate_review_intents',
      'memory_candidate_revisions',
      'memory_candidate_sources',
      'memory_candidates',
      'memory_extraction_jobs',
      'memory_promotion_confirmations',
      'memory_promotion_intents',
      'memory_revisions',
      'memory_revocation_events',
      'memory_versions',
      'message_purges',
      'model_price_versions',
      'oidc_identities',
      'oidc_transactions',
      'openbot_schema_migrations',
      'personal_model_connections',
      'run_approved_fact_references',
      'run_knowledge_references',
      'run_memory_references',
      'run_private_memory_references',
      'run_source_manifest_items',
      'run_source_manifests',
      'sessions',
      'task_cancel_commands',
      'task_cost_ledgers',
      'task_cost_reservations',
      'task_delegations',
      'task_execution_limit_grants',
      'task_execution_limit_snapshots',
      'task_execution_limit_warnings',
      'task_handoffs',
      'task_human_decisions',
      'task_human_requests',
      'task_pause_commands',
      'task_resume_commands',
      'task_retry_commands',
      'task_routing_decisions',
      'task_run_cancellations',
      'task_run_concurrency_holds',
      'task_run_delivery_receipts',
      'task_run_leases',
      'task_run_partial_outputs',
      'task_run_pause_checkpoints',
      'task_run_pauses',
      'task_run_recovery_receipts',
      'task_run_streams',
      'task_runs',
      'task_token_ledgers',
      'task_token_reservations',
      'tasks',
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
    ).resolves.toMatchObject({ rows: [{ version: '0049_group_archive' }] });
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

  it('reapplies COL-10 automatic-attempt guards after 0023 without recording a new version', async () => {
    const statements: string[] = [];
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? { rows: MIGRATION_VERSIONS.map((version) => ({ version })) }
          : { rows: [] };
      },
      release: () => undefined,
    };

    await migrateDatabase({ connect: async () => connection });

    expect(
      statements.some((statement) =>
        statement.includes("origin' IN ('provider_retry','model_fallback')"),
      ),
    ).toBe(true);
    expect(statements.some((statement) => statement.includes('fallbackBindings'))).toBe(true);
    expect(
      statements.some((statement) => statement.startsWith('INSERT INTO openbot_schema_migrations')),
    ).toBe(false);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('reapplies COL-08 pause guards after 0033 without recording a new version', async () => {
    const statements: string[] = [];
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? { rows: MIGRATION_VERSIONS.map((version) => ({ version })) }
          : { rows: [] };
      },
      release: () => undefined,
    };

    await migrateDatabase({ connect: async () => connection });

    const pauseOverlay = statements.findLastIndex((statement) =>
      statement.includes('CREATE OR REPLACE FUNCTION task_has_manual_resume_receipt'),
    );
    const automaticOverlay = statements.findIndex((statement) =>
      statement.includes("origin' IN ('provider_retry','model_fallback')"),
    );
    const recoveryOverlay = statements.findLastIndex((statement) =>
      statement.includes("origin' IN ('provider_retry','model_fallback','worker_recovery')"),
    );
    const limitOverlay = statements.findLastIndex((statement) =>
      statement.includes("NEW.status<>'waiting_budget'"),
    );
    const grantOverlay = statements.findLastIndex((statement) =>
      statement.includes('CREATE OR REPLACE FUNCTION task_has_budget_grant_receipt'),
    );
    const delegateOverlay = statements.findLastIndex((statement) =>
      statement.includes('CREATE OR REPLACE FUNCTION task_has_child_result_receipt'),
    );
    expect(automaticOverlay).toBeGreaterThanOrEqual(0);
    expect(pauseOverlay).toBeGreaterThan(automaticOverlay);
    expect(recoveryOverlay).toBeGreaterThan(pauseOverlay);
    expect(limitOverlay).toBeGreaterThan(recoveryOverlay);
    expect(grantOverlay).toBeGreaterThan(recoveryOverlay);
    expect(delegateOverlay).toBeGreaterThan(grantOverlay);
    expect(
      statements.some((statement) =>
        statement.includes(
          "parent.status='waiting_budget' AND latest.status IN ('failed','paused')",
        ),
      ),
    ).toBe(true);
    expect(statements.some((statement) => statement.includes("origin'='manual_resume'"))).toBe(
      true,
    );
    expect(
      statements.some((statement) =>
        statement.includes(
          "OLD.status='queued' AND NEW.status IN ('running','failed','cancelled','paused')",
        ),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.startsWith('INSERT INTO openbot_schema_migrations')),
    ).toBe(false);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('does not apply COL-08 pause guards before migration 0033', async () => {
    const statements: string[] = [];
    const through0023 = MIGRATION_VERSIONS.slice(
      0,
      MIGRATION_VERSIONS.indexOf('0023_task_tree_cancellation') + 1,
    );
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? { rows: through0023.map((version) => ({ version })) }
          : { rows: [] };
      },
      release: () => undefined,
    };

    await migrateDatabase(
      { connect: async () => connection },
      { throughVersion: '0023_task_tree_cancellation' },
    );

    expect(
      statements.some((statement) => statement.includes('task_has_manual_resume_receipt')),
    ).toBe(false);
    expect(
      statements.some((statement) =>
        statement.includes("origin' IN ('provider_retry','model_fallback')"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("origin' IN ('provider_retry','model_fallback','worker_recovery')"),
      ),
    ).toBe(false);
  });

  it('does not apply COL-10 automatic-attempt guards before migration 0023', async () => {
    const statements: string[] = [];
    const through0022 = MIGRATION_VERSIONS.slice(
      0,
      MIGRATION_VERSIONS.indexOf('0022_failed_task_retries') + 1,
    );
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? { rows: through0022.map((version) => ({ version })) }
          : { rows: [] };
      },
      release: () => undefined,
    };

    await migrateDatabase(
      { connect: async () => connection },
      { throughVersion: '0022_failed_task_retries' },
    );

    expect(statements.join('\n')).not.toContain("origin' IN ('provider_retry','model_fallback')");
    expect(statements.at(-1)).toBe('COMMIT');
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
  it('does not record the Bot migration when installing its native same-Bot pointer constraint fails', async () => {
    const statements: string[] = [];
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        if (statement.includes('ADD CONSTRAINT bots_current_version_same_bot'))
          throw new Error('native constraint installation failed');
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? {
              rows: MIGRATION_VERSIONS.filter((version) => version < '0012_bot_identity').map(
                (version) => ({ version }),
              ),
            }
          : { rows: [] };
      },
      release: () => undefined,
    };
    await expect(migrateDatabase({ connect: async () => connection })).rejects.toThrow(
      'native constraint installation failed',
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(
      statements.some((statement) => statement.startsWith('INSERT INTO openbot_schema_migrations')),
    ).toBe(false);
  });
});

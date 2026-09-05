import { ATTACHMENT_SCHEMA_STATEMENTS, ATTACHMENT_POSTGRES_GUARDS } from '../attachments/schema.js';
import { MEMORY_SCHEMA_STATEMENTS, MEMORY_POSTGRES_GUARDS } from '../memories/schema.js';
import { ROUTING_SCHEMA_STATEMENTS, ROUTING_POSTGRES_GUARDS } from '../routing/schema.js';
import { BOT_POSTGRES_GUARD_STATEMENTS, BOT_SCHEMA_STATEMENTS } from '../bots/schema.js';
import { BOT_LIFECYCLE_SCHEMA_STATEMENTS } from '../bots/lifecycle-schema.js';
import { AVATAR_SCHEMA_STATEMENTS, AVATAR_POSTGRES_GUARDS } from '../bots/avatar-schema.js';
import {
  CONVERSATION_SCHEMA_STATEMENTS,
  CONVERSATION_POSTGRES_GUARDS,
} from '../conversations/schema.js';
import { OIDC_SCHEMA_STATEMENTS } from '../oidc/schema.js';
import {
  PERSONAL_MODEL_CONNECTION_STATEMENTS,
  WORKSPACE_MODEL_CONNECTION_STATEMENTS,
} from '../providers/schema.js';
import { GROUP_SCHEMA_STATEMENTS } from '../groups/schema.js';
import { GROUP_BOT_SCHEMA_STATEMENTS, GROUP_BOT_POSTGRES_GUARDS } from '../group-bots/schema.js';
import { TASK_SCHEMA_STATEMENTS, TASK_POSTGRES_GUARDS } from '../tasks/schema.js';
import { TASK_RETRY_SCHEMA_STATEMENTS, TASK_RETRY_POSTGRES_GUARDS } from '../tasks/retry-schema.js';
import {
  TASK_CANCELLATION_SCHEMA_STATEMENTS,
  TASK_CANCELLATION_POSTGRES_PREFLIGHT,
} from '../tasks/cancellation-schema.js';
import { TASK_CANCELLATION_POSTGRES_GUARDS } from '../tasks/cancellation-postgres.js';
import {
  COL10_AUTOMATIC_ATTEMPT_POSTGRES_GUARDS,
  COL10_AUTOMATIC_ATTEMPT_REQUIRES_VERSION,
} from '../tasks/col10-postgres-guards.js';
import {
  CONVERSATION_STREAM_SCHEMA_STATEMENTS,
  CONVERSATION_STREAM_POSTGRES_GUARDS,
} from '../conversations/stream-schema.js';

interface MigrationConnection {
  query(statement: string, parameters?: unknown[]): Promise<unknown>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationConnection>;
}

export interface MigrationOptions {
  installPostgresGuards?: boolean;
  throughVersion?: string;
}

export const POSTGRES_AUDIT_APPEND_ONLY_STATEMENTS = [
  `
    CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'audit_events is append-only';
    END;
    $$
  `,
  'DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events',
  `
    CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_mutation()
  `,
] as const;

const AUTH_SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      normalized_email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      is_instance_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT users_email_not_blank CHECK (email <> ''),
      CONSTRAINT users_display_name_not_blank CHECK (display_name <> '')
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_credentials (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT local_credentials_argon2id CHECK (password_hash LIKE '$argon2id$%')
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT workspaces_name_not_blank CHECK (name <> '')
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS workspace_memberships (
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (workspace_id, user_id),
      CONSTRAINT workspace_memberships_role CHECK (role IN ('owner', 'administrator', 'member'))
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS instance_claims (
      singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE,
      owner_user_id UUID UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      claimed_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT instance_claims_singleton CHECK (singleton_key)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sessions (
      token_digest CHAR(64) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      CONSTRAINT sessions_valid_window CHECK (expires_at > created_at),
      CONSTRAINT sessions_valid_revocation CHECK (revoked_at IS NULL OR revoked_at >= created_at)
    )
  `,
  'CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)',
  `
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor_user_id UUID,
      occurred_at TIMESTAMPTZ NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT audit_events_type_not_blank CHECK (event_type <> '')
    )
  `,
  'CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx ON audit_events(occurred_at)',
] as const;

const MIGRATIONS = [
  {
    version: '0001_bootstrap',
    statements: [],
    postgresStatements: [],
  },
  {
    version: '0002_local_owner_auth',
    statements: AUTH_SCHEMA_STATEMENTS,
    postgresStatements: POSTGRES_AUDIT_APPEND_ONLY_STATEMENTS,
  },
  {
    version: '0003_workspace_settings',
    statements: [
      "ALTER TABLE workspaces ADD COLUMN description TEXT NOT NULL DEFAULT ''",
      'CREATE INDEX workspace_memberships_user_id_idx ON workspace_memberships(user_id)',
    ],
    postgresStatements: [],
  },
  {
    version: '0004_personal_model_connections',
    statements: PERSONAL_MODEL_CONNECTION_STATEMENTS,
    postgresStatements: [],
  },
  {
    version: '0005_workspace_invitations',
    statements: [
      `CREATE TABLE workspace_invitations (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
      token_digest CHAR(64) NOT NULL UNIQUE,
      created_by_user_id UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
      revoked_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      consumed_by_user_id UUID REFERENCES users(id),
      CHECK ((consumed_at IS NULL AND consumed_by_user_id IS NULL) OR (consumed_at IS NOT NULL AND consumed_by_user_id IS NOT NULL)),
      CHECK (consumed_at IS NULL OR revoked_at IS NULL)
    )`,
      'CREATE INDEX workspace_invitations_workspace_idx ON workspace_invitations(workspace_id)',
    ],
    postgresStatements: [],
  },
  {
    version: '0006_workspace_member_provenance',
    statements: [
      'ALTER TABLE workspace_memberships ADD COLUMN invitation_id UUID REFERENCES workspace_invitations(id)',
      `UPDATE workspace_memberships SET invitation_id = workspace_invitations.id FROM workspace_invitations WHERE workspace_invitations.workspace_id = workspace_memberships.workspace_id AND workspace_invitations.consumed_by_user_id = workspace_memberships.user_id AND workspace_invitations.consumed_at = workspace_memberships.created_at`,
    ],
    postgresStatements: [],
  },
  { version: '0007_oidc', statements: OIDC_SCHEMA_STATEMENTS, postgresStatements: [] },
  {
    version: '0008_workspace_model_connections',
    statements: WORKSPACE_MODEL_CONNECTION_STATEMENTS,
    postgresStatements: [],
  },
  {
    version: '0009_groups_and_human_memberships',
    statements: GROUP_SCHEMA_STATEMENTS,
    postgresStatements: [],
  },
  {
    version: '0010_scoped_api_tokens',
    statements: [
      `CREATE TABLE api_tokens (
        id UUID PRIMARY KEY,
        creator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (name <> ''),
        scopes TEXT[] NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        token_digest CHAR(64) NOT NULL UNIQUE
      )`,
      'CREATE INDEX api_tokens_creator_workspace_idx ON api_tokens(creator_user_id, workspace_id)',
    ],
    postgresStatements: [],
  },
  {
    version: '0011_model_capability_policies',
    statements: [
      "ALTER TABLE personal_model_connections ADD COLUMN policy JSONB NOT NULL DEFAULT '{}'::jsonb",
      "ALTER TABLE workspace_model_connections ADD COLUMN policy JSONB NOT NULL DEFAULT '{}'::jsonb",
    ],
    postgresStatements: [],
  },
  {
    version: '0012_bot_identity',
    statements: BOT_SCHEMA_STATEMENTS,
    postgresStatements: BOT_POSTGRES_GUARD_STATEMENTS,
  },
  {
    version: '0013_bot_avatar_objects',
    statements: AVATAR_SCHEMA_STATEMENTS,
    postgresStatements: AVATAR_POSTGRES_GUARDS,
  },
  {
    version: '0014_conversation_ledger',
    statements: CONVERSATION_SCHEMA_STATEMENTS,
    postgresStatements: CONVERSATION_POSTGRES_GUARDS,
  },
  {
    version: '0015_group_bot_grants',
    statements: GROUP_BOT_SCHEMA_STATEMENTS,
    postgresStatements: GROUP_BOT_POSTGRES_GUARDS,
  },
  {
    version: '0016_bot_lifecycle',
    statements: BOT_LIFECYCLE_SCHEMA_STATEMENTS,
    postgresStatements: [],
  },
  {
    version: '0017_single_bot_tasks',
    statements: TASK_SCHEMA_STATEMENTS,
    postgresStatements: TASK_POSTGRES_GUARDS,
  },
  {
    version: '0018_conversation_attachments',
    statements: ATTACHMENT_SCHEMA_STATEMENTS,
    postgresStatements: ATTACHMENT_POSTGRES_GUARDS,
  },
  {
    version: '0019_conversation_delivery',
    statements: CONVERSATION_STREAM_SCHEMA_STATEMENTS,
    postgresStatements: CONVERSATION_STREAM_POSTGRES_GUARDS,
  },
  {
    version: '0020_group_source_memories',
    statements: MEMORY_SCHEMA_STATEMENTS,
    postgresStatements: MEMORY_POSTGRES_GUARDS,
  },
  {
    version: '0021_deterministic_group_routing',
    statements: ROUTING_SCHEMA_STATEMENTS,
    postgresStatements: ROUTING_POSTGRES_GUARDS,
  },
  {
    version: '0022_failed_task_retries',
    statements: TASK_RETRY_SCHEMA_STATEMENTS,
    postgresStatements: TASK_RETRY_POSTGRES_GUARDS,
  },
  {
    version: '0023_task_tree_cancellation',
    postgresBeforeStatements: TASK_CANCELLATION_POSTGRES_PREFLIGHT,
    // The retained current-Run constraint must validate the legacy root
    // backfill immediately, before its following ALTER TABLE statements.
    postgresImmediateConstraints: ['tasks_current_run_required'],
    statements: TASK_CANCELLATION_SCHEMA_STATEMENTS,
    postgresStatements: TASK_CANCELLATION_POSTGRES_GUARDS,
  },
] as const;

export const MIGRATION_VERSIONS = MIGRATIONS.map(({ version }) => version);
export const CURRENT_MIGRATION_VERSION = MIGRATION_VERSIONS.at(-1)!;

function assertOrderedMigrationPrefix(appliedVersions: readonly string[]): void {
  const isKnownPrefix = appliedVersions.every(
    (version, index) => MIGRATIONS[index]?.version === version,
  );
  if (!isKnownPrefix) {
    throw new Error('Migration ledger is not an ordered prefix of known migrations');
  }
}

export async function migrateDatabase(
  database: MigrationPool,
  { installPostgresGuards = true, throughVersion }: MigrationOptions = {},
): Promise<void> {
  const targetIndex =
    throughVersion === undefined
      ? MIGRATIONS.length - 1
      : MIGRATIONS.findIndex(({ version }) => version === throughVersion);
  if (targetIndex < 0) throw new Error('Unknown migration target');
  const targetMigrations = MIGRATIONS.slice(0, targetIndex + 1);
  const connection = await database.connect();

  try {
    await connection.query('BEGIN');
    if (installPostgresGuards) {
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'openbot:schema-migrations',
      ]);
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS openbot_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const appliedResult = (await connection.query(
      'SELECT version FROM openbot_schema_migrations ORDER BY applied_at, version',
    )) as { rows: Array<{ version: string }> };
    const appliedVersionList = appliedResult.rows.map(({ version }) => version);
    assertOrderedMigrationPrefix(appliedVersionList);
    if (appliedVersionList.length > targetMigrations.length)
      throw new Error('Database is newer than the requested migration target');
    const appliedVersions = new Set(appliedVersionList);

    for (const migration of targetMigrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      if (installPostgresGuards && 'postgresBeforeStatements' in migration) {
        for (const statement of migration.postgresBeforeStatements)
          await connection.query(statement);
      }
      const immediateConstraints =
        installPostgresGuards && 'postgresImmediateConstraints' in migration
          ? migration.postgresImmediateConstraints.map((name) => `"${name}"`).join(',')
          : undefined;
      if (immediateConstraints)
        await connection.query(`SET CONSTRAINTS ${immediateConstraints} IMMEDIATE`);
      for (const statement of migration.statements) {
        await connection.query(statement);
      }
      if (immediateConstraints)
        await connection.query(`SET CONSTRAINTS ${immediateConstraints} DEFERRED`);
      if (installPostgresGuards) {
        for (const statement of migration.postgresStatements) {
          await connection.query(statement);
        }
      }
      await connection.query('INSERT INTO openbot_schema_migrations (version) VALUES ($1)', [
        migration.version,
      ]);
    }
    if (
      installPostgresGuards &&
      targetMigrations.some(({ version }) => version === COL10_AUTOMATIC_ATTEMPT_REQUIRES_VERSION)
    ) {
      for (const statement of COL10_AUTOMATIC_ATTEMPT_POSTGRES_GUARDS) {
        await connection.query(statement);
      }
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

interface MigrationConnection {
  query(statement: string, parameters?: unknown[]): Promise<unknown>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationConnection>;
}

export interface MigrationOptions {
  installPostgresGuards?: boolean;
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
  { installPostgresGuards = true }: MigrationOptions = {},
): Promise<void> {
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
    const appliedVersions = new Set(appliedVersionList);

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      for (const statement of migration.statements) {
        await connection.query(statement);
      }
      if (installPostgresGuards) {
        for (const statement of migration.postgresStatements) {
          await connection.query(statement);
        }
      }
      await connection.query('INSERT INTO openbot_schema_migrations (version) VALUES ($1)', [
        migration.version,
      ]);
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

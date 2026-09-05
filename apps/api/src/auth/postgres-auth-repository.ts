import {
  InstanceAlreadyClaimedError,
  type AuthRepository,
  type ClaimInstanceRecord,
  type CreateSessionRecord,
  type LocalCredentialRecord,
  type RevokeSessionRecord,
  type SessionIdentityRecord,
} from './repository.js';

interface QueryResult<Row extends Record<string, unknown>> {
  rowCount: number | null;
  rows: Row[];
}

export interface SqlConnection {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlConnection>;
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: SqlPool) {}

  async claimInstance(record: ClaimInstanceRecord): Promise<void> {
    const connection = await this.pool.connect();

    try {
      await connection.query('BEGIN');
      const claim = await connection.query<{ singleton_key: boolean }>(
        `
          INSERT INTO instance_claims (singleton_key, claimed_at)
          VALUES (TRUE, $1)
          ON CONFLICT (singleton_key) DO NOTHING
          RETURNING singleton_key
        `,
        [record.claimedAt],
      );
      if (claim.rows.length === 0) {
        throw new InstanceAlreadyClaimedError();
      }

      await connection.query(
        `
          INSERT INTO users (
            id, email, normalized_email, display_name, is_instance_admin, created_at
          ) VALUES ($1, $2, $2, $3, TRUE, $4)
        `,
        [record.userId, record.email, record.userDisplayName, record.claimedAt],
      );
      await connection.query(
        `
          INSERT INTO local_credentials (user_id, password_hash, updated_at)
          VALUES ($1, $2, $3)
        `,
        [record.userId, record.passwordHash, record.credentialUpdatedAt],
      );
      await connection.query('INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3)', [
        record.workspaceId,
        record.workspaceName,
        record.claimedAt,
      ]);
      await connection.query(
        `
          INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at)
          VALUES ($1, $2, 'owner', $3)
        `,
        [record.workspaceId, record.userId, record.claimedAt],
      );
      await connection.query(
        'UPDATE instance_claims SET owner_user_id = $1 WHERE singleton_key = TRUE',
        [record.userId],
      );
      await connection.query(
        `
          INSERT INTO sessions (token_digest, user_id, created_at, expires_at)
          VALUES ($1, $2, $3, $4)
        `,
        [
          record.sessionTokenDigest,
          record.userId,
          record.sessionCreatedAt,
          record.sessionExpiresAt,
        ],
      );
      await connection.query(
        `
          INSERT INTO audit_events (id, event_type, actor_user_id, occurred_at, metadata)
          VALUES ($1, 'instance.claimed', $2, $3, $4::jsonb)
        `,
        [
          record.instanceClaimAuditId,
          record.userId,
          record.claimedAt,
          JSON.stringify({ workspaceId: record.workspaceId }),
        ],
      );
      await connection.query(
        `
          INSERT INTO audit_events (id, event_type, actor_user_id, occurred_at, metadata)
          VALUES ($1, 'auth.signed_in', $2, $3, $4::jsonb)
        `,
        [
          record.sessionSignInAuditId,
          record.userId,
          record.sessionCreatedAt,
          JSON.stringify({ method: 'local' }),
        ],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async isClaimed(): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<{ claimed: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM instance_claims WHERE singleton_key = TRUE) AS claimed',
      );
      return result.rows[0]?.claimed === true;
    } finally {
      connection.release();
    }
  }

  async findLocalCredential(normalizedEmail: string): Promise<LocalCredentialRecord | undefined> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<{
        password_hash: string;
        user_display_name: string;
        user_email: string;
        user_id: string;
        workspace_id: string | null;
        workspace_name: string | null;
      }>(
        `
          SELECT
            credentials.password_hash,
            users.display_name AS user_display_name,
            users.email AS user_email,
            users.id AS user_id,
            workspaces.id AS workspace_id,
            workspaces.name AS workspace_name
          FROM users
          INNER JOIN local_credentials AS credentials ON credentials.user_id = users.id
          LEFT JOIN workspace_memberships AS memberships ON memberships.user_id = users.id
          LEFT JOIN workspaces ON workspaces.id = memberships.workspace_id
          WHERE users.normalized_email = $1
          ORDER BY memberships.created_at, workspaces.id
          LIMIT 1
        `,
        [normalizedEmail],
      );
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }

      return {
        passwordHash: row.password_hash,
        userDisplayName: row.user_display_name,
        userEmail: row.user_email,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
      };
    } finally {
      connection.release();
    }
  }

  async createSession(record: CreateSessionRecord): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        `
          INSERT INTO sessions (token_digest, user_id, created_at, expires_at)
          VALUES ($1, $2, $3, $4)
        `,
        [record.tokenDigest, record.userId, record.createdAt, record.expiresAt],
      );
      await connection.query(
        `
          INSERT INTO audit_events (id, event_type, actor_user_id, occurred_at, metadata)
          VALUES ($1, 'auth.signed_in', $2, $3, $4::jsonb)
        `,
        [record.auditId, record.userId, record.createdAt, JSON.stringify({ method: 'local' })],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async findSession(tokenDigest: string, now: Date): Promise<SessionIdentityRecord | undefined> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<{
        user_display_name: string;
        user_email: string;
        user_id: string;
        workspace_id: string | null;
        workspace_name: string | null;
      }>(
        `
          SELECT
            users.display_name AS user_display_name,
            users.email AS user_email,
            users.id AS user_id,
            workspaces.id AS workspace_id,
            workspaces.name AS workspace_name
          FROM sessions
          INNER JOIN users ON users.id = sessions.user_id
          LEFT JOIN workspace_memberships AS memberships ON memberships.user_id = users.id
          LEFT JOIN workspaces ON workspaces.id = memberships.workspace_id
          WHERE sessions.token_digest = $1
            AND sessions.revoked_at IS NULL
            AND sessions.expires_at > $2
          ORDER BY memberships.created_at, workspaces.id
          LIMIT 1
        `,
        [tokenDigest, now],
      );
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }

      return {
        userDisplayName: row.user_display_name,
        userEmail: row.user_email,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
      };
    } finally {
      connection.release();
    }
  }

  async revokeSession(record: RevokeSessionRecord): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const revoked = await connection.query<{ user_id: string }>(
        `
          UPDATE sessions
          SET revoked_at = $2
          WHERE token_digest = $1
            AND revoked_at IS NULL
            AND expires_at > $2
          RETURNING user_id
        `,
        [record.tokenDigest, record.revokedAt],
      );
      const userId = revoked.rows[0]?.user_id;
      if (!userId) {
        await connection.query('COMMIT');
        return false;
      }

      await connection.query(
        `
          INSERT INTO audit_events (id, event_type, actor_user_id, occurred_at, metadata)
          VALUES ($1, 'auth.signed_out', $2, $3, $4::jsonb)
        `,
        [record.auditId, userId, record.revokedAt, JSON.stringify({})],
      );
      await connection.query('COMMIT');
      return true;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}

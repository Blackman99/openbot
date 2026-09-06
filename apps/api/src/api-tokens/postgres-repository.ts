import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { lockWorkspaceAuthority } from '../database/workspace-lock.js';
import type { WorkspaceRole } from '../workspaces/service.js';
import {
  type ApiToken,
  type RevokeApiTokenRecord,
  ApiTokenNotFoundError,
  ApiTokenInputError,
  type ApiTokenIdentity,
  type ApiTokenScope,
  type AuthorizeApiTokenRecord,
  ApiTokenAccessError,
  type ApiTokenRepository,
  type CreateApiTokenRecord,
  type RecheckApiTokenRecord,
  ApiTokenAuthenticationError,
  ApiTokenScopeError,
} from './service.js';

type TokenRow = {
  id: string;
  creator_user_id: string;
  workspace_id: string;
  name: string;
  scopes: ApiTokenScope[];
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};
function toToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    creatorUserId: row.creator_user_id,
    workspaceId: row.workspace_id,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
type AuthorizedTokenRow = {
  id: string;
  creator_user_id: string;
  workspace_id: string;
  scopes: ApiTokenScope[];
  email: string;
  display_name: string;
  name: string;
  role: WorkspaceRole;
};
async function readAuthorizedToken(connection: SqlConnection, digest: string, occurredAt: Date) {
  return (
    await connection.query<AuthorizedTokenRow>(
      `SELECT t.id,t.creator_user_id,t.workspace_id,t.scopes,u.email,u.display_name,w.name,m.role
      FROM api_tokens t INNER JOIN users u ON u.id = t.creator_user_id
      INNER JOIN workspaces w ON w.id = t.workspace_id
      INNER JOIN workspace_memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.creator_user_id
      WHERE t.token_digest = $1 AND t.revoked_at IS NULL AND t.expires_at > $2`,
      [digest, occurredAt],
    )
  ).rows[0];
}
export class PostgresApiTokenRepository implements ApiTokenRepository {
  constructor(private readonly pool: SqlPool) {}
  async assertCurrent(connection: SqlConnection, record: RecheckApiTokenRecord, clock: () => Date) {
    // The domain operation already holds this same workspace lock. Never route
    // the final check to a workspace or creator supplied by a public request.
    await lockWorkspaceAuthority(connection, record.workspaceId);
    const row = await readAuthorizedToken(connection, record.tokenDigest, clock());
    if (
      !row ||
      row.id !== record.tokenId ||
      row.creator_user_id !== record.creatorUserId ||
      row.workspace_id !== record.workspaceId
    )
      throw new ApiTokenAuthenticationError();
    if (!row.scopes.includes(record.requiredScope)) throw new ApiTokenScopeError();
  }
  async list(creatorUserId: string, workspaceId: string): Promise<ApiToken[]> {
    const connection = await this.pool.connect();
    try {
      const access = await connection.query(
        'SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, creatorUserId],
      );
      if (!access.rows[0]) throw new ApiTokenAccessError();
      const rows = await connection.query<TokenRow>(
        `SELECT t.id,t.creator_user_id,t.workspace_id,t.name,t.scopes,t.created_at,t.expires_at,t.last_used_at,t.revoked_at
        FROM api_tokens t INNER JOIN workspace_memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.creator_user_id
        WHERE t.workspace_id = $1 AND t.creator_user_id = $2 ORDER BY t.created_at DESC,t.id`,
        [workspaceId, creatorUserId],
      );
      return rows.rows.map(toToken);
    } finally {
      connection.release();
    }
  }
  async revoke(record: RevokeApiTokenRecord): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await lockWorkspaceAuthority(connection, record.workspaceId);
      const access = await connection.query(
        'SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [record.workspaceId, record.actorUserId],
      );
      if (!access.rows[0]) throw new ApiTokenAccessError();
      const row = (
        await connection.query<{ revoked_at: Date | null }>(
          'SELECT revoked_at FROM api_tokens WHERE id = $1 AND workspace_id = $2 AND creator_user_id = $3',
          [record.tokenId, record.workspaceId, record.actorUserId],
        )
      ).rows[0];
      if (!row) throw new ApiTokenNotFoundError();
      if (row.revoked_at === null) {
        await connection.query('UPDATE api_tokens SET revoked_at = $2 WHERE id = $1', [
          record.tokenId,
          record.occurredAt,
        ]);
        await connection.query(
          "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'api_token.revoked',$2,$3,$4::jsonb)",
          [
            record.auditId,
            record.actorUserId,
            record.occurredAt,
            JSON.stringify({
              tokenId: record.tokenId,
              workspaceId: record.workspaceId,
              reason: 'creator',
            }),
          ],
        );
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async authorize(
    record: AuthorizeApiTokenRecord,
    clock: () => Date,
  ): Promise<ApiTokenIdentity | 'insufficient_scope' | undefined> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const candidate = (
        await connection.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM api_tokens WHERE token_digest = $1',
          [record.tokenDigest],
        )
      ).rows[0];
      if (!candidate) {
        await connection.query('COMMIT');
        return undefined;
      }
      await lockWorkspaceAuthority(connection, candidate.workspace_id);
      const occurredAt = clock();
      const row = await readAuthorizedToken(connection, record.tokenDigest, occurredAt);
      if (!row) {
        await connection.query('COMMIT');
        return undefined;
      }
      const allowed = row.scopes.includes(record.requiredScope);
      if (allowed)
        await connection.query('UPDATE api_tokens SET last_used_at = $2 WHERE id = $1', [
          row.id,
          occurredAt,
        ]);
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'api_token.used',$2,$3,$4::jsonb)",
        [
          record.auditId,
          row.creator_user_id,
          occurredAt,
          JSON.stringify({
            tokenId: row.id,
            workspaceId: row.workspace_id,
            scope: record.requiredScope,
            outcome: allowed ? 'allowed' : 'insufficient_scope',
          }),
        ],
      );
      await connection.query('COMMIT');
      return allowed
        ? {
            user: { id: row.creator_user_id, email: row.email, displayName: row.display_name },
            workspace: { id: row.workspace_id, name: row.name, role: row.role },
            token: { id: row.id, scopes: row.scopes },
          }
        : 'insufficient_scope';
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async create(
    { token: pendingToken, tokenDigest, auditId }: CreateApiTokenRecord,
    clock: () => Date,
  ): Promise<ApiToken> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await lockWorkspaceAuthority(connection, pendingToken.workspaceId);
      const token = { ...pendingToken, createdAt: clock() };
      if (token.expiresAt <= token.createdAt) throw new ApiTokenInputError();
      const membership = await connection.query(
        'SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [token.workspaceId, token.creatorUserId],
      );
      if (!membership.rows[0]) throw new ApiTokenAccessError();
      await connection.query(
        'INSERT INTO api_tokens (id, creator_user_id, workspace_id, name, scopes, created_at, expires_at, token_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          token.id,
          token.creatorUserId,
          token.workspaceId,
          token.name,
          token.scopes,
          token.createdAt,
          token.expiresAt,
          tokenDigest,
        ],
      );
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'api_token.created',$2,$3,$4::jsonb)",
        [
          auditId,
          token.creatorUserId,
          token.createdAt,
          JSON.stringify({
            tokenId: token.id,
            workspaceId: token.workspaceId,
            scopes: token.scopes,
          }),
        ],
      );
      await connection.query('COMMIT');
      return token;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}

// The caller holds the workspace lock and commits this with membership removal.
export async function revokeMembershipApiTokens(
  connection: SqlConnection,
  record: { actorUserId: string; workspaceId: string; targetUserId: string; occurredAt: Date },
): Promise<void> {
  const revoked = await connection.query<{ id: string; workspace_id: string }>(
    'UPDATE api_tokens SET revoked_at = $3 WHERE workspace_id = $1 AND creator_user_id = $2 AND revoked_at IS NULL RETURNING id, workspace_id',
    [record.workspaceId, record.targetUserId, record.occurredAt],
  );
  for (const token of revoked.rows) {
    await connection.query(
      "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'api_token.revoked',$2,$3,$4::jsonb)",
      [
        randomUUID(),
        record.actorUserId,
        record.occurredAt,
        JSON.stringify({
          tokenId: token.id,
          workspaceId: token.workspace_id,
          reason: 'member_removed',
        }),
      ],
    );
  }
}

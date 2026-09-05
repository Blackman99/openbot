import type { SessionIdentity } from '../auth/service.js';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import {
  InvitationAccessError,
  InvitationUnavailableError,
  type InvitationAccept,
  InvitationWorkspaceError,
  type Invitation,
  type InvitationRepository,
  type InvitationWrite,
} from './service.js';

const columns =
  'id, workspace_id AS "workspaceId", email, role, created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt", consumed_at AS "consumedAt"';
export class PostgresInvitationRepository implements InvitationRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private async authorize(
    connection: SqlConnection,
    userId: string,
    workspaceId: string,
    lock = false,
  ): Promise<void> {
    const workspace = await connection.query(
      'SELECT id FROM workspaces WHERE id = $1' + (lock ? ' FOR UPDATE' : ''),
      [workspaceId],
    );
    if (!workspace.rows[0]) throw new InvitationWorkspaceError();
    const membership = await connection.query<{ role: string }>(
      'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    if (!membership.rows[0]) throw new InvitationAccessError();
    if (!['owner', 'administrator'].includes(membership.rows[0].role))
      throw new InvitationAccessError();
  }
  async findAvailable(tokenDigest: string, now: Date): Promise<Invitation | undefined> {
    const connection = await this.pool.connect();
    try {
      return (
        await connection.query<Invitation>(
          `SELECT ${columns} FROM workspace_invitations WHERE token_digest = $1 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > $2`,
          [tokenDigest, now],
        )
      ).rows[0];
    } finally {
      connection.release();
    }
  }
  async accept(record: InvitationAccept): Promise<SessionIdentity> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const initial = (
        await connection.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM workspace_invitations WHERE token_digest = $1',
          [record.tokenDigest],
        )
      ).rows[0];
      if (!initial) throw new InvitationUnavailableError();
      const workspace = (
        await connection.query<{ id: string; name: string }>(
          'SELECT id, name FROM workspaces WHERE id = $1 FOR UPDATE',
          [initial.workspace_id],
        )
      ).rows[0];
      const invitation = (
        await connection.query<Invitation>(
          `SELECT ${columns} FROM workspace_invitations WHERE token_digest = $1 FOR UPDATE`,
          [record.tokenDigest],
        )
      ).rows[0];
      const acceptedAt = new Date(Math.max(record.now.getTime(), this.clock().getTime()));
      if (
        !workspace ||
        !invitation ||
        invitation.revokedAt ||
        invitation.consumedAt ||
        invitation.expiresAt <= acceptedAt ||
        invitation.email !== record.email
      )
        throw new InvitationUnavailableError();
      let user: SessionIdentity['user'];
      if (record.newAccount && record.session) {
        const existing = await connection.query(
          'SELECT id FROM users WHERE normalized_email = $1',
          [record.email],
        );
        if (existing.rows[0]) throw new InvitationUnavailableError();
        user = {
          id: record.userId,
          displayName: record.newAccount.displayName,
          email: record.email,
        };
        await connection.query(
          'INSERT INTO users (id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$3,$4)',
          [user.id, user.email, user.displayName, acceptedAt],
        );
        await connection.query(
          'INSERT INTO local_credentials (user_id,password_hash,updated_at) VALUES ($1,$2,$3)',
          [user.id, record.newAccount.passwordHash, acceptedAt],
        );
        await connection.query(
          'INSERT INTO sessions (token_digest,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)',
          [record.session.tokenDigest, user.id, acceptedAt, record.session.expiresAt],
        );
        await connection.query(
          "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at) VALUES ($1,'session.signed_in',$2,$3)",
          [record.session.auditId, user.id, acceptedAt],
        );
      } else {
        const existing = (
          await connection.query<{ id: string; email: string; displayName: string }>(
            'SELECT id,email,display_name AS "displayName" FROM users WHERE id = $1 AND normalized_email = $2',
            [record.userId, record.email],
          )
        ).rows[0];
        if (!existing) throw new InvitationUnavailableError();
        user = existing;
      }
      const member = await connection.query(
        'SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [workspace.id, user.id],
      );
      if (member.rows[0]) throw new InvitationUnavailableError();
      await connection.query(
        'INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at,invitation_id) VALUES ($1,$2,$3,$4,$5)',
        [workspace.id, user.id, invitation.role, acceptedAt, invitation.id],
      );
      const consumed = await connection.query(
        'UPDATE workspace_invitations SET consumed_at = $2, consumed_by_user_id = $3 WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2 RETURNING id',
        [invitation.id, acceptedAt, user.id],
      );
      if (!consumed.rows[0]) throw new InvitationUnavailableError();
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'invitation.accepted',$2,$3,$4::jsonb)",
        [
          record.auditId,
          user.id,
          acceptedAt,
          JSON.stringify({
            workspaceId: workspace.id,
            invitationId: invitation.id,
            role: invitation.role,
          }),
        ],
      );
      await connection.query('COMMIT');
      return { user, workspace };
    } catch (error) {
      await connection.query('ROLLBACK');
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        throw new InvitationUnavailableError();
      throw error;
    } finally {
      connection.release();
    }
  }
  async revoke(
    actorUserId: string,
    workspaceId: string,
    invitationId: string,
    now: Date,
    auditId: string,
  ): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await this.authorize(connection, actorUserId, workspaceId, true);
      const revoked = await connection.query(
        'UPDATE workspace_invitations SET revoked_at = $3 WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL AND consumed_at IS NULL RETURNING id',
        [invitationId, workspaceId, now],
      );
      if (!revoked.rows[0]) throw new InvitationUnavailableError();
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'invitation.revoked',$2,$3,$4::jsonb)",
        [auditId, actorUserId, now, JSON.stringify({ workspaceId, invitationId })],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async create(record: InvitationWrite): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await this.authorize(connection, record.actorUserId, record.workspaceId, true);
      await connection.query(
        'INSERT INTO workspace_invitations (id, workspace_id, email, role, created_at, expires_at, token_digest, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          record.id,
          record.workspaceId,
          record.email,
          record.role,
          record.createdAt,
          record.expiresAt,
          record.tokenDigest,
          record.actorUserId,
        ],
      );
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'invitation.created',$2,$3,$4::jsonb)",
        [
          record.auditId,
          record.actorUserId,
          record.createdAt,
          JSON.stringify({
            workspaceId: record.workspaceId,
            invitationId: record.id,
            role: record.role,
          }),
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
  async list(actorUserId: string, workspaceId: string): Promise<Invitation[]> {
    const connection = await this.pool.connect();
    try {
      await this.authorize(connection, actorUserId, workspaceId);
      return (
        await connection.query<Invitation>(
          `SELECT ${columns} FROM workspace_invitations WHERE workspace_id = $1 AND workspace_id IN (SELECT workspace_id FROM workspace_memberships WHERE user_id = $2 AND role IN ('owner', 'administrator')) ORDER BY created_at DESC, id`,
          [workspaceId, actorUserId],
        )
      ).rows;
    } finally {
      connection.release();
    }
  }
}

import { revokeMembershipApiTokens } from '../api-tokens/postgres-repository.js';
import type { SqlPool } from '../auth/postgres-auth-repository.js';
import type { WorkspaceRole } from '../workspaces/service.js';
import {
  WorkspaceMemberAccessError,
  LastWorkspaceOwnerError,
  WorkspaceMemberNotFoundError,
  type MemberRoleWrite,
  type MemberRemovalWrite,
  type WorkspaceMember,
  type WorkspaceMemberRepository,
} from './service.js';

type MemberRow = {
  user_id: string;
  email: string;
  display_name: string;
  role: WorkspaceRole;
  created_at: Date;
  invitation_id: string | null;
  invited_by_id: string | null;
  invited_by_name: string | null;
};
const MEMBER_SELECT = `
        SELECT m.user_id, u.email, u.display_name, m.role, m.created_at, i.id AS invitation_id,
          creator.id AS invited_by_id, creator.display_name AS invited_by_name
        FROM workspace_memberships m INNER JOIN users u ON m.user_id = u.id
        LEFT JOIN workspace_invitations i ON m.invitation_id = i.id AND i.workspace_id = m.workspace_id AND i.consumed_by_user_id = m.user_id
        LEFT JOIN users creator ON i.created_by_user_id = creator.id
`;
function toMember(row: MemberRow): WorkspaceMember {
  return {
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
    role: row.role,
    joinedAt: row.created_at,
    invitation:
      row.invitation_id && row.invited_by_id && row.invited_by_name
        ? {
            id: row.invitation_id,
            invitedBy: { id: row.invited_by_id, displayName: row.invited_by_name },
          }
        : null,
  };
}
const authority = { member: 1, administrator: 2, owner: 3 } as const;
export class PostgresWorkspaceMemberRepository implements WorkspaceMemberRepository {
  constructor(private readonly pool: SqlPool) {}
  changeRole(record: MemberRoleWrite): Promise<WorkspaceMember> {
    return this.mutate(record, record.role);
  }
  async remove(record: MemberRemovalWrite): Promise<void> {
    await this.mutate(record, null);
  }
  private async mutate(
    record: MemberRemovalWrite,
    role: WorkspaceRole | null,
  ): Promise<WorkspaceMember> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const workspace = await connection.query(
        'SELECT id FROM workspaces WHERE id = $1 FOR UPDATE',
        [record.workspaceId],
      );
      if (!workspace.rows[0]) throw new WorkspaceMemberAccessError();
      const actor = (
        await connection.query<{ role: WorkspaceRole }>(
          'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
          [record.workspaceId, record.actorUserId],
        )
      ).rows[0];
      if (!actor || actor.role === 'member') throw new WorkspaceMemberAccessError();
      const target = (
        await connection.query<MemberRow>(
          `${MEMBER_SELECT} WHERE m.workspace_id = $1 AND m.user_id = $2`,
          [record.workspaceId, record.targetUserId],
        )
      ).rows[0];
      if (!target) throw new WorkspaceMemberNotFoundError();
      if (
        authority[target.role] > authority[actor.role] ||
        (role !== null && authority[role] > authority[actor.role])
      )
        throw new WorkspaceMemberAccessError();
      if (target.role === 'owner' && role !== 'owner') {
        const owners = await connection.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner'",
          [record.workspaceId],
        );
        if ((owners.rows[0]?.count ?? 0) <= 1) throw new LastWorkspaceOwnerError();
      }
      if (role === null) {
        await revokeMembershipApiTokens(connection, record);
        await connection.query(
          'DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
          [record.workspaceId, record.targetUserId],
        );
        await connection.query(
          "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'workspace.member_removed',$2,$3,$4::jsonb)",
          [
            record.auditId,
            record.actorUserId,
            record.occurredAt,
            JSON.stringify({
              workspaceId: record.workspaceId,
              targetUserId: record.targetUserId,
              role: target.role,
            }),
          ],
        );
      } else if (target.role !== role) {
        await connection.query(
          'UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
          [record.workspaceId, record.targetUserId, role],
        );
        await connection.query(
          "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'workspace.member_role_changed',$2,$3,$4::jsonb)",
          [
            record.auditId,
            record.actorUserId,
            record.occurredAt,
            JSON.stringify({
              workspaceId: record.workspaceId,
              targetUserId: record.targetUserId,
              fromRole: target.role,
              toRole: role,
            }),
          ],
        );
      }
      await connection.query('COMMIT');
      return toMember({ ...target, role: role ?? target.role });
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async list(actorUserId: string, workspaceId: string): Promise<WorkspaceMember[]> {
    const connection = await this.pool.connect();
    try {
      const access = await connection.query(
        'SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, actorUserId],
      );
      if (!access.rows[0]) throw new WorkspaceMemberAccessError();
      const result = await connection.query<MemberRow>(
        `${MEMBER_SELECT}
        WHERE m.workspace_id = $1 AND m.workspace_id IN (SELECT workspace_id FROM workspace_memberships WHERE user_id = $2)
        ORDER BY m.created_at, m.user_id
      `,
        [workspaceId, actorUserId],
      );
      return result.rows.map(toMember);
    } finally {
      connection.release();
    }
  }
}

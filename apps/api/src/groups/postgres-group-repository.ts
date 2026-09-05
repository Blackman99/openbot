import type { SqlPool, SqlConnection } from '../auth/postgres-auth-repository.js';
import {
  GroupAccessError,
  GroupMemberConflictError,
  GroupMemberNotFoundError,
  LastGroupOwnerError,
  type Group,
  type GroupCreate,
  type GroupRepository,
  type GroupRole,
  type GroupVisibility,
  type GroupMember,
  type GroupContentAccess,
  type GroupMemberWrite,
  type GroupMemberRemoval,
  type GroupMetadataWrite,
} from './service.js';

type GroupRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  visibility: GroupVisibility;
  role: GroupRole | null;
  created_at: Date;
  updated_at: Date;
};
function groupDto(row: GroupRow): Group {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresGroupRepository implements GroupRepository {
  constructor(private readonly pool: SqlPool) {}
  async update(record: GroupMetadataWrite): Promise<Group> {
    return this.manage(record, async (connection, group) => {
      const changedFields = (['name', 'description', 'visibility'] as const).filter(
        (field) => record.changes[field] !== undefined && record.changes[field] !== group[field],
      );
      if (!changedFields.length) return group;
      const updated = { ...group, ...record.changes, updatedAt: record.occurredAt };
      await connection.query(
        'UPDATE groups SET name=$3,description=$4,visibility=$5,updated_at=$6 WHERE workspace_id=$1 AND id=$2',
        [
          record.workspaceId,
          record.groupId,
          updated.name,
          updated.description,
          updated.visibility,
          record.occurredAt,
        ],
      );
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'group.metadata_changed',$2,$3,$4::jsonb)",
        [
          record.auditId,
          record.actorId,
          record.occurredAt,
          JSON.stringify({
            groupId: record.groupId,
            workspaceId: record.workspaceId,
            changedFields,
          }),
        ],
      );
      return updated;
    });
  }
  async changeRole(record: GroupMemberWrite): Promise<GroupMember> {
    return this.mutateMember(record, record.role);
  }
  async removeMember(record: GroupMemberRemoval): Promise<void> {
    await this.mutateMember(record, null);
  }
  private async mutateMember(
    record: GroupMemberRemoval,
    role: GroupRole | null,
  ): Promise<GroupMember> {
    return this.manage(record, async (connection, group) => {
      const target = (
        await connection.query<{
          user_id: string;
          email: string;
          display_name: string;
          role: GroupRole;
          created_at: Date;
          has_workspace_access: boolean;
        }>(
          `SELECT m.user_id,u.email,u.display_name,m.role,m.created_at,(wm.user_id IS NOT NULL) AS has_workspace_access FROM group_memberships m INNER JOIN users u ON u.id=m.user_id LEFT JOIN workspace_memberships wm ON wm.user_id=m.user_id AND wm.workspace_id=$1 WHERE m.group_id=$2 AND m.user_id=$3`,
          [record.workspaceId, record.groupId, record.targetUserId],
        )
      ).rows[0];
      if (!target) throw new GroupMemberNotFoundError();
      if (group.role !== 'owner' && (target.role === 'owner' || role === 'owner'))
        throw new GroupAccessError();
      if (target.role === 'owner' && target.has_workspace_access && role !== 'owner') {
        const owners =
          (
            await connection.query<{ count: number }>(
              "SELECT COUNT(*)::int AS count FROM group_memberships gm INNER JOIN workspace_memberships wm ON wm.user_id=gm.user_id AND wm.workspace_id=$1 WHERE gm.group_id=$2 AND gm.role='owner'",
              [record.workspaceId, record.groupId],
            )
          ).rows[0]?.count ?? 0;
        if (owners <= 1) throw new LastGroupOwnerError();
      }
      if (role === null) {
        await connection.query('DELETE FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
          record.groupId,
          record.targetUserId,
        ]);
        await connection.query(
          "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'group.member_removed',$2,$3,$4::jsonb)",
          [
            record.auditId,
            record.actorId,
            record.occurredAt,
            JSON.stringify({
              groupId: record.groupId,
              workspaceId: record.workspaceId,
              targetUserId: record.targetUserId,
              role: target.role,
            }),
          ],
        );
      } else if (target.role !== role) {
        await connection.query(
          'UPDATE group_memberships SET role=$3 WHERE group_id=$1 AND user_id=$2',
          [record.groupId, record.targetUserId, role],
        );
        await connection.query(
          "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'group.member_role_changed',$2,$3,$4::jsonb)",
          [
            record.auditId,
            record.actorId,
            record.occurredAt,
            JSON.stringify({
              groupId: record.groupId,
              workspaceId: record.workspaceId,
              targetUserId: record.targetUserId,
              fromRole: target.role,
              toRole: role,
            }),
          ],
        );
      }
      return {
        user: { id: target.user_id, email: target.email, displayName: target.display_name },
        role: role ?? target.role,
        joinedAt: target.created_at,
        hasWorkspaceAccess: target.has_workspace_access,
      };
    });
  }
  async addMember(record: GroupMemberWrite): Promise<GroupMember> {
    return this.manage(record, async (connection, group) => {
      if (record.role === 'owner' && group.role !== 'owner') throw new GroupAccessError();
      const target = (
        await connection.query<{ id: string; email: string; display_name: string }>(
          'SELECT u.id,u.email,u.display_name FROM users u INNER JOIN workspace_memberships wm ON wm.user_id=u.id WHERE wm.workspace_id=$1 AND u.id=$2',
          [record.workspaceId, record.targetUserId],
        )
      ).rows[0];
      if (!target) throw new GroupMemberNotFoundError();
      const existing = await connection.query(
        'SELECT user_id FROM group_memberships WHERE group_id=$1 AND user_id=$2',
        [record.groupId, record.targetUserId],
      );
      if (existing.rows[0]) throw new GroupMemberConflictError();
      await connection.query(
        'INSERT INTO group_memberships (group_id,user_id,role,created_at) VALUES ($1,$2,$3,$4)',
        [record.groupId, record.targetUserId, record.role, record.occurredAt],
      );
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'group.member_added',$2,$3,$4::jsonb)",
        [
          record.auditId,
          record.actorId,
          record.occurredAt,
          JSON.stringify({
            groupId: record.groupId,
            workspaceId: record.workspaceId,
            targetUserId: record.targetUserId,
            role: record.role,
          }),
        ],
      );
      return {
        user: { id: target.id, email: target.email, displayName: target.display_name },
        role: record.role,
        joinedAt: record.occurredAt,
        hasWorkspaceAccess: true,
      };
    });
  }
  private async manage<T>(
    record: { actorId: string; workspaceId: string; groupId: string },
    operation: (connection: SqlConnection, group: GroupContentAccess) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const workspace = await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
        record.workspaceId,
      ]);
      if (!workspace.rows[0]) throw new GroupAccessError();
      const membership = await connection.query(
        'SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
        [record.workspaceId, record.actorId],
      );
      if (!membership.rows[0]) throw new GroupAccessError();
      const group = (
        await connection.query<Omit<GroupRow, 'role'>>(
          'SELECT id,workspace_id,name,description,visibility,created_at,updated_at FROM groups WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [record.workspaceId, record.groupId],
        )
      ).rows[0];
      if (!group) throw new GroupAccessError();
      const actor = (
        await connection.query<{ role: GroupRole }>(
          'SELECT role FROM group_memberships WHERE group_id=$1 AND user_id=$2',
          [record.groupId, record.actorId],
        )
      ).rows[0];
      if (!actor || actor.role === 'member') throw new GroupAccessError();
      const result = await operation(connection, {
        ...groupDto({ ...group, role: actor.role }),
        role: actor.role,
      });
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async authorizeContent(
    actorId: string,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupContentAccess> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<GroupRow>(
        `SELECT g.id,g.workspace_id,g.name,g.description,g.visibility,g.created_at,g.updated_at,gm.role FROM groups g INNER JOIN workspace_memberships wm ON wm.workspace_id=g.workspace_id AND wm.user_id=$2 INNER JOIN group_memberships gm ON gm.group_id=g.id AND gm.user_id=$2 WHERE g.workspace_id=$1 AND g.id=$3`,
        [workspaceId, actorId, groupId],
      );
      const row = result.rows[0];
      if (!row?.role) throw new GroupAccessError();
      return { ...groupDto(row), role: row.role };
    } finally {
      connection.release();
    }
  }
  async members(actorId: string, workspaceId: string, groupId: string): Promise<GroupMember[]> {
    await this.authorizeContent(actorId, workspaceId, groupId);
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<{
        user_id: string;
        email: string;
        display_name: string;
        role: GroupRole;
        created_at: Date;
        has_workspace_access: boolean;
      }>(
        `SELECT m.user_id,u.email,u.display_name,m.role,m.created_at,(target_workspace.user_id IS NOT NULL) AS has_workspace_access FROM groups g INNER JOIN workspace_memberships viewer_workspace ON viewer_workspace.workspace_id=g.workspace_id AND viewer_workspace.user_id=$2 INNER JOIN group_memberships viewer ON viewer.group_id=g.id AND viewer.user_id=$2 INNER JOIN group_memberships m ON m.group_id=g.id INNER JOIN users u ON u.id=m.user_id LEFT JOIN workspace_memberships target_workspace ON target_workspace.workspace_id=g.workspace_id AND target_workspace.user_id=m.user_id WHERE g.workspace_id=$1 AND g.id=$3 ORDER BY m.created_at,m.user_id`,
        [workspaceId, actorId, groupId],
      );
      return result.rows.map((row) => ({
        user: { id: row.user_id, email: row.email, displayName: row.display_name },
        role: row.role,
        joinedAt: row.created_at,
        hasWorkspaceAccess: row.has_workspace_access,
      }));
    } finally {
      connection.release();
    }
  }
  list(actorId: string, workspaceId: string): Promise<Group[]> {
    return this.metadata(actorId, workspaceId);
  }
  async get(actorId: string, workspaceId: string, groupId: string): Promise<Group> {
    const group = (await this.metadata(actorId, workspaceId, groupId))[0];
    if (!group) throw new GroupAccessError();
    return group;
  }
  private async metadata(actorId: string, workspaceId: string, groupId?: string): Promise<Group[]> {
    const connection = await this.pool.connect();
    try {
      const membership = await connection.query(
        'SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
        [workspaceId, actorId],
      );
      if (!membership.rows[0]) throw new GroupAccessError();
      const result = await connection.query<GroupRow>(
        `SELECT g.id,g.workspace_id,g.name,g.description,g.visibility,g.created_at,g.updated_at,gm.role FROM groups g INNER JOIN workspace_memberships wm ON wm.workspace_id=g.workspace_id AND wm.user_id=$2 LEFT JOIN group_memberships gm ON gm.group_id=g.id AND gm.user_id=$2 WHERE g.workspace_id=$1 AND (g.visibility='workspace' OR gm.user_id IS NOT NULL) ${groupId ? 'AND g.id=$3' : ''} ORDER BY g.created_at,g.id`,
        groupId ? [workspaceId, actorId, groupId] : [workspaceId, actorId],
      );
      return result.rows.map(groupDto);
    } finally {
      connection.release();
    }
  }
  async create(record: GroupCreate): Promise<Group> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const workspace = await connection.query(
        'SELECT id FROM workspaces WHERE id = $1 FOR UPDATE',
        [record.workspaceId],
      );
      if (!workspace.rows[0]) throw new GroupAccessError();
      const membership = await connection.query(
        'SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [record.workspaceId, record.actorId],
      );
      if (!membership.rows[0]) throw new GroupAccessError();
      await connection.query(
        'INSERT INTO groups (id,workspace_id,name,description,visibility,created_by_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
        [
          record.id,
          record.workspaceId,
          record.name,
          record.description,
          record.visibility,
          record.actorId,
          record.occurredAt,
        ],
      );
      await connection.query(
        "INSERT INTO group_memberships (group_id,user_id,role,created_at) VALUES ($1,$2,'owner',$3)",
        [record.id, record.actorId, record.occurredAt],
      );
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'group.created',$2,$3,$4::jsonb)",
        [
          record.auditId,
          record.actorId,
          record.occurredAt,
          JSON.stringify({
            groupId: record.id,
            workspaceId: record.workspaceId,
            visibility: record.visibility,
          }),
        ],
      );
      await connection.query('COMMIT');
      return {
        id: record.id,
        workspaceId: record.workspaceId,
        name: record.name,
        description: record.description,
        visibility: record.visibility,
        role: 'owner',
        createdAt: record.occurredAt,
        updatedAt: record.occurredAt,
      };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}

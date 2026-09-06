import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { lockWorkspaceAuthority } from '../database/workspace-lock.js';
import {
  GroupAccessError,
  GroupArchivedError,
  type GroupContentAccess,
  type GroupRole,
  type GroupVisibility,
} from './service.js';

async function groupArchivedAt(connection: SqlConnection, groupId: string): Promise<Date | null> {
  const column = await connection.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='groups' AND column_name='archived_at'`,
  );
  if (!column.rows[0]) return null;
  return (
    (
      await connection.query<{ archived_at: Date | null }>(
        'SELECT archived_at FROM groups WHERE id=$1',
        [groupId],
      )
    ).rows[0]?.archived_at ?? null
  );
}

// Borrow the caller's transaction. All membership writers take these same locks.
export async function lockAuthorizedGroup(
  connection: SqlConnection,
  access: { actorId: string; workspaceId: string; groupId: string },
  permission: 'content' | 'manage' | 'archive',
): Promise<GroupContentAccess> {
  if (!(await lockWorkspaceAuthority(connection, access.workspaceId))) throw new GroupAccessError();
  const membership = await connection.query(
    'SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
    [access.workspaceId, access.actorId],
  );
  if (!membership.rows[0]) throw new GroupAccessError();
  const group = (
    await connection.query<{
      id: string;
      workspace_id: string;
      name: string;
      description: string;
      visibility: GroupVisibility;
      created_at: Date;
      updated_at: Date;
    }>(
      'SELECT id,workspace_id,name,description,visibility,created_at,updated_at FROM groups WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [access.workspaceId, access.groupId],
    )
  ).rows[0];
  if (!group) throw new GroupAccessError();
  const actor = (
    await connection.query<{ role: GroupRole }>(
      'SELECT role FROM group_memberships WHERE group_id=$1 AND user_id=$2',
      [access.groupId, access.actorId],
    )
  ).rows[0];
  if (!actor || (permission !== 'content' && actor.role === 'member')) throw new GroupAccessError();
  if (permission === 'manage' && (await groupArchivedAt(connection, group.id)))
    throw new GroupArchivedError();
  return {
    id: group.id,
    workspaceId: group.workspace_id,
    name: group.name,
    description: group.description,
    visibility: group.visibility,
    role: actor.role,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
  };
}

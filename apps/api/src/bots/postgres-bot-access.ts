import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import {
  BotAccessError,
  type BotConfiguration,
  type BotRole,
  type BotVersion,
  type BotLifecycleState,
} from './service.js';

export type BotRow = {
  id: string;
  lifecycle_state: BotLifecycleState;
  deleted_at: Date | null;
  recovery_deadline: Date | null;
  pre_deleted_state: 'active' | 'archived' | null;
  workspace_id: string;
  visibility: 'private' | 'workspace';
  role: BotRole | null;
  version_id: string;
  version: number;
  configuration: BotConfiguration;
  author_user_id: string;
  author_name: string;
  version_created_at: Date;
  rationale: string;
};
export type BotPermission =
  'discover' | 'inspect' | 'use' | 'edit' | 'manageAcl' | 'manageLifecycle';
export interface BotAccess {
  actorUserId: string;
  workspaceId: string;
  botId: string;
}
// The caller owns the transaction. A dependent write and its audit must commit
// together while these workspace -> Bot locks remain held. Provider admission,
// when required, comes after this fresh independent ACL check.
export async function lockAuthorizedBot(
  connection: SqlConnection,
  access: BotAccess,
  permission: BotPermission,
): Promise<BotRow> {
  await lockBotWorkspace(connection, access.actorUserId, access.workspaceId);
  const bot = await connection.query(
    'SELECT id FROM bots WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [access.workspaceId, access.botId],
  );
  if (!bot.rows[0]) throw new BotAccessError();
  const row = (
    await readVisibleBots(connection, access.actorUserId, access.workspaceId, access.botId)
  )[0];
  if (!row) throw new BotAccessError();
  const allowed =
    permission === 'discover' ||
    row.role === 'owner' ||
    (row.role === 'editor' && ['inspect', 'use', 'edit'].includes(permission)) ||
    (row.role === 'user' && ['inspect', 'use'].includes(permission));
  if (!allowed || (row.lifecycle_state === 'deleted' && row.role === null))
    throw new BotAccessError();
  if (permission === 'use' && row.lifecycle_state !== 'active') throw new BotAccessError();
  return row;
}
export async function lockBotWorkspace(
  connection: SqlConnection,
  actorUserId: string,
  workspaceId: string,
) {
  const workspace = await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
    workspaceId,
  ]);
  if (!workspace.rows[0]) throw new BotAccessError();
  const user = (
    await connection.query<{ id: string; display_name: string }>(
      'SELECT u.id,u.display_name FROM workspace_memberships m INNER JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2',
      [workspaceId, actorUserId],
    )
  ).rows[0];
  if (!user) throw new BotAccessError();
  return user;
}
export async function readVisibleBots(
  connection: SqlConnection,
  actorUserId: string,
  workspaceId: string,
  botId?: string,
) {
  return (
    await connection.query<BotRow>(
      `SELECT b.id,b.workspace_id,b.visibility,b.lifecycle_state,b.deleted_at,b.recovery_deadline,b.pre_deleted_state,a.role,v.id AS version_id,v.version,v.configuration,v.author_user_id,u.display_name AS author_name,v.created_at AS version_created_at,v.rationale
     FROM bots b INNER JOIN bot_versions v ON v.id=b.current_version_id AND v.bot_id=b.id INNER JOIN users u ON u.id=v.author_user_id
     LEFT JOIN bot_acl a ON a.bot_id=b.id AND a.user_id=$2
     WHERE b.workspace_id=$1 AND (b.visibility='workspace' OR a.user_id IS NOT NULL) ${botId ? 'AND b.id=$3' : ''} ORDER BY b.created_at,b.id`,
      botId ? [workspaceId, actorUserId, botId] : [workspaceId, actorUserId],
    )
  ).rows;
}
export function botVersion(row: BotRow): BotVersion {
  return {
    id: row.version_id,
    number: row.version,
    configuration: row.configuration,
    author: { id: row.author_user_id, displayName: row.author_name },
    createdAt: row.version_created_at,
    rationale: row.rationale,
  };
}

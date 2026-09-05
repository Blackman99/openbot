import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { appendBotRemoved } from '../conversations/append-event.js';
import { groupBotUuid, GroupBotAccessError, type GroupBotClosureReason } from './service.js';

interface ClosureGrant {
  id: string;
  workspaceId: string;
  groupId: string;
  botId: string;
  conversationId: string;
  grantorUserId: string;
}
// Typed grant closure only. This cannot obtain a ConversationTransaction or
// expose/read/edit human content, including when the actor is a workspace admin.
export async function closeGroupBotGrant(
  connection: SqlConnection,
  actorUserId: string,
  supplied: ClosureGrant,
  reason: GroupBotClosureReason,
  command: { idempotencyKey: string; hash: string },
  now: () => Date,
) {
  const grant = Object.freeze({ ...supplied });
  const row = (
    await connection.query<{ close_event_id: string | null }>(
      'SELECT close_event_id FROM group_bot_grants WHERE id=$1 AND workspace_id=$2 AND group_id=$3 AND bot_id=$4 AND conversation_id=$5 AND granted_by_user_id=$6',
      [
        grant.id,
        grant.workspaceId,
        grant.groupId,
        grant.botId,
        grant.conversationId,
        grant.grantorUserId,
      ],
    )
  ).rows[0];
  if (!row) throw new GroupBotAccessError();
  if (row.close_event_id) return;
  const receipt = await appendBotRemoved(
    connection,
    { actorUserId, workspaceId: grant.workspaceId, conversationId: grant.conversationId },
    {
      ...command,
      groupId: grant.groupId,
      botId: grant.botId,
      grantId: grant.id,
      grantorUserId: grant.grantorUserId,
      reason,
    },
    now,
  );
  await connection.query(
    'UPDATE group_bot_grants SET close_event_id=$2,close_sequence=$3,closed_at=$4,closure_reason=$5 WHERE id=$1 AND close_event_id IS NULL',
    [grant.id, receipt.eventId, receipt.sequence, receipt.occurredAt, reason],
  );
}

export class GroupBotRevocations {
  private constructor(
    private readonly connection: SqlConnection,
    private readonly actorUserId: string,
    private readonly grants: readonly Readonly<ClosureGrant>[],
    private readonly reason: 'bot-access-revoked' | 'workspace-access-removed',
    private readonly now: () => Date,
  ) {}
  // Call at the workspace-locked mutation entry point, before acquiring Bot
  // locks. Final ACL/member mutation admission still belongs to that repository.
  static forBotRevocation(
    connection: SqlConnection,
    access: { actorUserId: string; workspaceId: string; botId: string; targetUserId: string },
    now: () => Date,
  ) {
    return this.prepare(connection, access, 'bot-access-revoked', now, groupBotUuid(access.botId));
  }
  static forWorkspaceRemoval(
    connection: SqlConnection,
    access: { actorUserId: string; workspaceId: string; targetUserId: string },
    now: () => Date,
  ) {
    return this.prepare(connection, access, 'workspace-access-removed', now);
  }
  private static async prepare(
    connection: SqlConnection,
    supplied: { actorUserId: string; workspaceId: string; targetUserId: string },
    reason: 'bot-access-revoked' | 'workspace-access-removed',
    now: () => Date,
    botId?: string,
  ) {
    const access = Object.freeze({
      actorUserId: groupBotUuid(supplied.actorUserId),
      workspaceId: groupBotUuid(supplied.workspaceId),
      targetUserId: groupBotUuid(supplied.targetUserId),
    });
    await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
      access.workspaceId,
    ]);
    const rows = (
      await connection.query<{
        id: string;
        group_id: string;
        bot_id: string;
        conversation_id: string;
        granted_by_user_id: string;
      }>(
        `SELECT id,group_id,bot_id,conversation_id,granted_by_user_id FROM group_bot_grants WHERE workspace_id=$1 AND granted_by_user_id=$2 AND close_event_id IS NULL ${botId ? 'AND bot_id=$3' : ''} ORDER BY group_id,bot_id,id`,
        botId
          ? [access.workspaceId, access.targetUserId, botId]
          : [access.workspaceId, access.targetUserId],
      )
    ).rows;
    for (const groupId of [...new Set(rows.map((row) => row.group_id))].sort())
      await connection.query('SELECT id FROM groups WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        access.workspaceId,
        groupId,
      ]);
    for (const id of [...new Set(rows.map((row) => row.bot_id))].sort())
      await connection.query('SELECT id FROM bots WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        access.workspaceId,
        id,
      ]);
    return new GroupBotRevocations(
      connection,
      access.actorUserId,
      Object.freeze(
        rows.map((row) =>
          Object.freeze({
            id: row.id,
            workspaceId: access.workspaceId,
            groupId: row.group_id,
            botId: row.bot_id,
            conversationId: row.conversation_id,
            grantorUserId: row.granted_by_user_id,
          }),
        ),
      ),
      reason,
      now,
    );
  }
  async close() {
    for (const grant of this.grants) {
      const idempotencyKey = `grant-close:${randomUUID()}`;
      const hash = createHash('sha256')
        .update(JSON.stringify({ type: 'bot.removed', grantId: grant.id, reason: this.reason }))
        .digest('hex');
      await closeGroupBotGrant(
        this.connection,
        this.actorUserId,
        grant,
        this.reason,
        { idempotencyKey, hash },
        this.now,
      );
    }
  }
}

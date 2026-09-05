import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { lockAuthorizedBot } from '../bots/postgres-bot-access.js';
import { GroupAccessError } from '../groups/service.js';
import { BotAccessError } from '../bots/service.js';
import { currentPage } from '../conversations/projection.js';
import { messageCursor, encodeMessageCursor } from '../conversations/cursor.js';
import type { MessageRead } from '../conversations/service.js';
import {
  GroupBotAccessError,
  groupBotAccess,
  groupBotUuid,
  type GroupBotAccess,
  type GroupBotContext,
} from './service.js';

// Borrows the caller's transaction. Keep it open through any dependent write.
// This admits only the pinned group grant's context, never direct Bot inspection.
export class GroupBotTransaction {
  private constructor(
    private readonly connection: SqlConnection,
    private readonly access: Readonly<GroupBotAccess>,
    private readonly grant: Readonly<{
      id: string;
      botId: string;
      conversationId: string;
      lowerBound: number;
    }>,
  ) {}
  static async lock(connection: SqlConnection, supplied: GroupBotAccess & { grantId: string }) {
    const access = groupBotAccess(supplied.actorUserId, supplied.workspaceId, supplied.groupId);
    const grantId = groupBotUuid(supplied.grantId);
    try {
      await lockAuthorizedGroup(
        connection,
        { actorId: access.actorUserId, workspaceId: access.workspaceId, groupId: access.groupId },
        'content',
      );
      const row = (
        await connection.query<{
          id: string;
          bot_id: string;
          conversation_id: string;
          granted_by_user_id: string;
          lower_bound: string | number;
          close_event_id: string | null;
        }>(
          'SELECT id,bot_id,conversation_id,granted_by_user_id,lower_bound,close_event_id FROM group_bot_grants WHERE workspace_id=$1 AND group_id=$2 AND id=$3',
          [access.workspaceId, access.groupId, grantId],
        )
      ).rows[0];
      if (!row || row.close_event_id) throw new GroupBotAccessError();
      await lockAuthorizedBot(
        connection,
        { actorUserId: row.granted_by_user_id, workspaceId: access.workspaceId, botId: row.bot_id },
        'use',
      );
      const conversation = await connection.query(
        'SELECT id FROM conversations WHERE workspace_id=$1 AND group_id=$2 AND id=$3 FOR UPDATE',
        [access.workspaceId, access.groupId, row.conversation_id],
      );
      if (!conversation.rows[0]) throw new GroupBotAccessError();
      return new GroupBotTransaction(
        connection,
        access,
        Object.freeze({
          id: row.id,
          botId: row.bot_id,
          conversationId: row.conversation_id,
          lowerBound: Number(row.lower_bound),
        }),
      );
    } catch (error) {
      if (error instanceof GroupAccessError || error instanceof BotAccessError)
        throw new GroupBotAccessError();
      throw error;
    }
  }
  async context(read: MessageRead): Promise<GroupBotContext> {
    read = { ...read };
    const last = (
      await this.connection.query<{ last_sequence: string | number }>(
        'SELECT last_sequence FROM conversations WHERE id=$1',
        [this.grant.conversationId],
      )
    ).rows[0]!;
    const cursor = messageCursor(
      read.cursor,
      this.grant.conversationId,
      Number(last.last_sequence),
    );
    const page = await currentPage(
      this.connection,
      this.grant.conversationId,
      Math.max(cursor.after, this.grant.lowerBound - 1),
      cursor.horizon,
      read.limit,
      this.access.actorUserId,
      false,
    );
    return {
      grantId: this.grant.id,
      conversationId: this.grant.conversationId,
      messages: page.messages.map((message) => ({
        ...message,
        canEdit: false,
        canDelete: false,
        canAudit: false,
      })),
      nextCursor: page.hasMore
        ? encodeMessageCursor({ ...cursor, after: page.messages.at(-1)!.creationSequence })
        : null,
    };
  }
}

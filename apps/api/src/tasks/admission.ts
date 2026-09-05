import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { BotConfiguration } from '../bots/service.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import {
  ConversationAccessError,
  type ConversationAccess,
  conversationUuid,
} from '../conversations/service.js';
import { GroupBotTransaction } from '../group-bots/postgres-admission.js';

// The caller owns the transaction. Group admission precedes the conversation
// lock and uses the grantor's Bot ACL, never an implicit ACL for the requester.
export async function admitTaskTarget(
  connection: SqlConnection,
  access: ConversationAccess,
  groupGrantId: string | null,
  now: () => Date,
  versionId?: string,
) {
  const subject = (
    await connection.query<{ group_id: string | null; bot_id: string | null }>(
      'SELECT group_id,bot_id FROM conversations WHERE workspace_id=$1 AND id=$2',
      [access.workspaceId, access.conversationId],
    )
  ).rows[0];
  if (!subject) throw new ConversationAccessError();
  if (subject.group_id) {
    if (!groupGrantId) throw new ConversationAccessError();
    const grant = await GroupBotTransaction.lock(connection, {
      ...access,
      groupId: subject.group_id,
      grantId: groupGrantId,
    });
    const target = await grant.executionTarget(versionId);
    if (target.conversationId !== access.conversationId) throw new ConversationAccessError();
    return { ...target, conversation: await ConversationTransaction.lock(connection, access, now) };
  }
  if (groupGrantId) throw new ConversationAccessError();
  const conversation = await ConversationTransaction.lock(connection, access, now);
  const bot = (
    await connection.query<{
      id: string;
      version_id: string;
      version: number;
      configuration: BotConfiguration;
    }>(
      `SELECT b.id,v.id AS version_id,v.version,v.configuration FROM bots b JOIN bot_versions v ON v.bot_id=b.id
     WHERE b.workspace_id=$1 AND b.id=$2 AND v.id=${versionId === undefined ? 'b.current_version_id' : '$3'}`,
      versionId === undefined
        ? [access.workspaceId, subject.bot_id]
        : [access.workspaceId, subject.bot_id, conversationUuid(versionId)],
    )
  ).rows[0];
  if (!bot) throw new ConversationAccessError();
  return {
    botId: bot.id,
    versionId: bot.version_id,
    versionNumber: bot.version,
    configuration: structuredClone(bot.configuration),
    conversationId: access.conversationId,
    groupGrantId: null,
    lowerBound: 1,
    conversation,
  };
}

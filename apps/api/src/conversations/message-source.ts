import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { projectMessage, type MessageEventRow } from './projection.js';
import { ConversationAccessError, conversationUuid, type MessageProjection } from './service.js';

export interface CurrentMessageSource {
  workspaceId: string;
  groupId: string;
  conversationId: string;
  messageId: string;
  creationEventId: string;
  creationSequence: number;
  versionEventId: string;
  version: number;
  body: string;
  author: MessageProjection['author'];
  createdAt: Date;
  updatedAt: Date;
}

// Internal point selector. Its callers retain the current human/exact-grant
// admission and conversation lock; this function never grants access itself.
export async function selectCurrentMessageSource(
  connection: SqlConnection,
  scope: { workspaceId: string; groupId: string; conversationId: string },
  messageId: string,
  lowerBound = 1,
): Promise<CurrentMessageSource> {
  messageId = conversationUuid(messageId);
  const original = (
    await connection.query<MessageEventRow>(
      `SELECT e.*,u.display_name FROM conversation_events e
        JOIN conversations c ON c.id=e.conversation_id JOIN users u ON u.id=e.actor_user_id
        WHERE c.workspace_id=$1 AND c.group_id=$2 AND c.id=$3 AND e.message_id=$4
          AND e.event_type IN ('message.created','bot.message.created') ORDER BY e.sequence LIMIT 1`,
      [scope.workspaceId, scope.groupId, scope.conversationId, messageId],
    )
  ).rows[0];
  if (!original || Number(original.sequence) < lowerBound) throw new ConversationAccessError();
  const purge = await connection.query(
    'SELECT state FROM message_purges WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3',
    [scope.workspaceId, scope.conversationId, messageId],
  );
  if (purge.rows[0]) throw new ConversationAccessError();
  const latest = (
    await connection.query<MessageEventRow>(
      `SELECT e.*,u.display_name FROM conversation_events e JOIN users u ON u.id=e.actor_user_id
        WHERE e.conversation_id=$1 AND e.message_id=$2 ORDER BY e.sequence DESC LIMIT 1`,
      [scope.conversationId, messageId],
    )
  ).rows[0];
  if (!latest || latest.event_type === 'message.deleted' || !latest.body?.trim())
    throw new ConversationAccessError();
  const projected = projectMessage(original, latest, '', false);
  return {
    ...scope,
    messageId,
    creationEventId: original.id,
    creationSequence: Number(original.sequence),
    versionEventId: latest.id,
    version: latest.message_version,
    body: latest.body,
    author: projected.author,
    createdAt: original.occurred_at,
    updatedAt: latest.occurred_at,
  };
}

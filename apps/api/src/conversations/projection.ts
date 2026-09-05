import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { MessageProjection, MessageVersion } from './service.js';
export type MessageEventRow = {
  id: string;
  message_id: string;
  sequence: string | number;
  message_version: number;
  event_type: MessageVersion['type'];
  actor_user_id: string;
  display_name: string;
  body: string | null;
  reason: string | null;
  occurred_at: Date;
};
export async function readMessageEvents(
  connection: SqlConnection,
  conversationId: string,
  messageId: string,
): Promise<MessageEventRow[]> {
  return (
    await connection.query<MessageEventRow>(
      'SELECT e.*,u.display_name FROM conversation_events e INNER JOIN users u ON u.id=e.actor_user_id WHERE e.conversation_id=$1 AND e.message_id=$2 ORDER BY e.sequence',
      [conversationId, messageId],
    )
  ).rows;
}
export async function currentPage(
  connection: SqlConnection,
  conversationId: string,
  after: number,
  horizon: number,
  limit: number,
  actorUserId: string,
  moderator: boolean,
) {
  const originals = (
    await connection.query<MessageEventRow>(
      "SELECT e.*,u.display_name FROM conversation_events e INNER JOIN users u ON u.id=e.actor_user_id WHERE e.conversation_id=$1 AND e.event_type='message.created' AND e.sequence>$2 AND e.sequence<=$3 ORDER BY e.sequence LIMIT $4",
      [conversationId, after, horizon, limit + 1],
    )
  ).rows;
  const selected = originals.slice(0, limit);
  if (!selected.length) return { messages: [], hasMore: false };
  const placeholders = selected.map((_, index) => `$${index + 2}`).join(',');
  const latest = (
    await connection.query<MessageEventRow>(
      `SELECT e.*,u.display_name FROM conversation_events e INNER JOIN users u ON u.id=e.actor_user_id WHERE e.conversation_id=$1 AND e.sequence IN (SELECT MAX(sequence) FROM conversation_events WHERE conversation_id=$1 AND message_id IN (${placeholders}) GROUP BY message_id) ORDER BY e.sequence`,
      [conversationId, ...selected.map((event) => event.message_id)],
    )
  ).rows;
  const byMessage = new Map(latest.map((event) => [event.message_id, event]));
  return {
    messages: selected.map((original) =>
      projectMessage(original, byMessage.get(original.message_id)!, actorUserId, moderator),
    ),
    hasMore: originals.length > limit,
  };
}
// Select eligible original creation events before passing them here. A later
// edit must never make an otherwise ineligible original visible to a consumer.
export function projectMessage(
  original: MessageEventRow,
  current: MessageEventRow,
  actorUserId: string,
  moderator: boolean,
): MessageProjection {
  const author = original.actor_user_id === actorUserId;
  const deleted = current.event_type === 'message.deleted';
  return {
    id: original.message_id,
    creationSequence: Number(original.sequence),
    versionEventId: current.id,
    sequence: Number(current.sequence),
    version: current.message_version,
    author: { id: original.actor_user_id, displayName: original.display_name },
    body: deleted ? null : current.body,
    reason: current.reason,
    deleted,
    createdAt: original.occurred_at,
    updatedAt: current.occurred_at,
    canEdit: author && !deleted,
    canDelete: (author || moderator) && !deleted,
    canAudit: author || moderator,
  };
}
export function messageVersion(event: MessageEventRow): MessageVersion {
  return {
    id: event.id,
    sequence: Number(event.sequence),
    type: event.event_type,
    version: event.message_version,
    actor: { id: event.actor_user_id, displayName: event.display_name },
    occurredAt: event.occurred_at,
    body: event.body,
    reason: event.reason,
  };
}

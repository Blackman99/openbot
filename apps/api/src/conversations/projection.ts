import { attachmentMetadata, type AttachmentRow } from '../attachments/types.js';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { ConversationAccessError, type MessageProjection, type MessageVersion } from './service.js';
export type MessageEventRow = {
  id: string;
  message_id: string;
  sequence: string | number;
  message_version: number;
  event_type: MessageVersion['type'] | 'bot.message.created';
  event_data?: {
    attachmentId?: string;
    bot?: { id: string; displayName: string; versionId: string; versionNumber: number };
  };
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
  humanOnly = false,
) {
  const originals = (
    await connection.query<MessageEventRow>(
      `SELECT e.*,u.display_name FROM conversation_events e INNER JOIN users u ON u.id=e.actor_user_id WHERE e.conversation_id=$1 AND ${humanOnly ? "e.event_type='message.created'" : "e.event_type IN ('message.created','bot.message.created')"} AND e.sequence>$2 AND e.sequence<=$3 ORDER BY e.sequence LIMIT $4`,
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
  const messages = [];
  for (const original of selected) {
    const message = projectMessage(
      original,
      byMessage.get(original.message_id)!,
      actorUserId,
      moderator,
    );
    const purge = (
      await connection.query(
        'SELECT state FROM message_purges WHERE conversation_id=$1 AND message_id=$2',
        [conversationId, original.message_id],
      )
    ).rows[0];
    if (purge) {
      message.body = null;
      message.reason = 'Message purged';
      message.deleted = true;
      message.canEdit = false;
      message.canDelete = false;
      message.canAudit = false;
    }
    if (!message.deleted && original.event_data?.attachmentId) {
      const row = (
        await connection.query<AttachmentRow>(
          "SELECT * FROM attachment_objects WHERE conversation_id=$1 AND message_id=$2 AND id=$3 AND state='live'",
          [conversationId, original.message_id, original.event_data.attachmentId],
        )
      ).rows[0];
      if (row) message.attachment = attachmentMetadata(row);
    }
    messages.push(message);
  }
  return {
    messages,
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
  const bot = original.event_type === 'bot.message.created' ? original.event_data?.bot : undefined;
  if (original.event_type === 'bot.message.created' && !bot) throw new ConversationAccessError();
  const author = !bot && original.actor_user_id === actorUserId;
  const deleted = current.event_type === 'message.deleted';
  return {
    id: original.message_id,
    creationSequence: Number(original.sequence),
    versionEventId: current.id,
    sequence: Number(current.sequence),
    version: current.message_version,
    author: bot
      ? { kind: 'bot', ...bot }
      : { id: original.actor_user_id, displayName: original.display_name },
    body: deleted ? null : current.body,
    reason: current.reason,
    deleted,
    createdAt: original.occurred_at,
    updatedAt: current.occurred_at,
    canEdit: author && !deleted,
    canDelete: !bot && (author || moderator) && !deleted,
    canAudit: !bot && (author || moderator),
  };
}
export function messageVersion(event: MessageEventRow): MessageVersion {
  if (event.event_type === 'bot.message.created') throw new ConversationAccessError();
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

import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { encodeMessageCursor } from './cursor.js';
import { ConversationAccessError } from './service.js';
import type { MessageReference } from './stream-protocol.js';

// Current-source locator metadata only: no historical body or attachment
// metadata enters the delivery log, snapshot or replay buffer.
export async function readStreamMessageReference(
  connection: SqlConnection,
  conversationId: string,
  messageId: string,
): Promise<MessageReference> {
  const original = (
    await connection.query<{
      message_id: string;
      sequence: string | number;
      bot_run_id: string | null;
    }>(
      "SELECT message_id,sequence,bot_run_id FROM conversation_events WHERE conversation_id=$1 AND message_id=$2 AND event_type IN ('message.created','bot.message.created') LIMIT 1",
      [conversationId, messageId],
    )
  ).rows[0];
  if (!original) throw new ConversationAccessError();
  const current = (
    await connection.query<{ id: string; sequence: string | number; event_type: string }>(
      'SELECT id,sequence,event_type FROM conversation_events WHERE conversation_id=$1 AND message_id=$2 ORDER BY sequence DESC LIMIT 1',
      [conversationId, messageId],
    )
  ).rows[0]!;
  const purge = (
    await connection.query(
      'SELECT message_id FROM message_purges WHERE conversation_id=$1 AND message_id=$2',
      [conversationId, messageId],
    )
  ).rows[0];
  const task = original.bot_run_id
    ? (
        await connection.query<{ task_id: string }>('SELECT task_id FROM task_runs WHERE id=$1', [
          original.bot_run_id,
        ])
      ).rows[0]
    : undefined;
  return {
    messageId: original.message_id,
    creationSequence: Number(original.sequence),
    versionEventId: current.id,
    sequence: Number(current.sequence),
    deleted: current.event_type === 'message.deleted' || !!purge,
    taskId: task?.task_id ?? null,
    runId: original.bot_run_id,
  };
}
export async function readStreamMessagePage(
  connection: SqlConnection,
  conversationId: string,
  horizon: number,
) {
  const originals = (
    await connection.query<{ message_id: string; sequence: string | number }>(
      "SELECT message_id,sequence FROM conversation_events WHERE conversation_id=$1 AND event_type IN ('message.created','bot.message.created') AND sequence<=$2 ORDER BY sequence LIMIT 21",
      [conversationId, horizon],
    )
  ).rows;
  const messages: MessageReference[] = [];
  for (const original of originals.slice(0, 20))
    messages.push(
      await readStreamMessageReference(connection, conversationId, original.message_id),
    );
  return {
    messages,
    nextMessageCursor:
      originals.length > 20
        ? encodeMessageCursor({
            v: 1,
            conversationId,
            after: messages.at(-1)!.creationSequence,
            horizon,
          })
        : null,
  };
}

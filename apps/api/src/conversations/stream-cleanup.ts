import type { SqlPool } from '../auth/postgres-auth-repository.js';
import { STREAM_LIMITS } from './stream-protocol.js';
import { reclaimConversationStream } from './stream-retention.js';

export async function cleanupConversationStreams(pool: SqlPool, now = new Date()): Promise<number> {
  const discovery = await pool.connect();
  let conversations: { conversation_id: string }[];
  try {
    conversations = (
      await discovery.query<{ conversation_id: string }>(
        'SELECT DISTINCT conversation_id FROM conversation_delivery_events WHERE occurred_at<=$1 ORDER BY conversation_id LIMIT 5',
        [new Date(now.getTime() - STREAM_LIMITS.retentionMs)],
      )
    ).rows;
  } finally {
    discovery.release();
  }
  for (const row of conversations) {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      // Retention only takes the conversation lock, never a later source lock.
      // It cannot authorize content or invert a worker's scope-first ordering.
      await connection.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
        row.conversation_id,
      ]);
      await reclaimConversationStream(connection, row.conversation_id, now);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  return conversations.length;
}
export function startConversationStreamCleanup(
  pool: SqlPool,
  onError: () => void,
): () => Promise<void> {
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = cleanupConversationStreams(pool)
      .then(() => undefined, onError)
      .finally(() => {
        active = undefined;
      });
  }, 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await active;
  };
}

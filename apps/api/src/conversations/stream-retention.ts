import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { STREAM_LIMITS } from './stream-protocol.js';

// Caller holds this conversation's allocation lock. Reclaim only a prefix and
// move the durable floor with its counters in the same transaction as deletion.
export async function reclaimConversationStream(
  connection: SqlConnection,
  conversationId: string,
  now: Date,
) {
  const rows = (
    await connection.query<{ sequence: string | number; occurred_at: Date; byte_size: number }>(
      'SELECT sequence,occurred_at,byte_size FROM conversation_delivery_events WHERE conversation_id=$1 ORDER BY sequence LIMIT 10001',
      [conversationId],
    )
  ).rows;
  let bytes = rows.reduce((sum, row) => sum + row.byte_size, 0),
    remove = 0;
  const expiredAt = now.getTime() - STREAM_LIMITS.retentionMs;
  for (let i = 0; i < rows.length; i++)
    if (rows[i]!.occurred_at.getTime() <= expiredAt) remove = i + 1;
  for (let i = 0; i < remove; i++) bytes -= rows[i]!.byte_size;
  while (rows.length - remove > STREAM_LIMITS.retainedEvents || bytes > STREAM_LIMITS.retainedBytes)
    bytes -= rows[remove++]!.byte_size;
  if (remove) {
    const floor = Number(rows[remove - 1]!.sequence);
    await connection.query(
      'UPDATE conversation_delivery_state SET floor=$2,retained_count=$3,retained_bytes=$4 WHERE conversation_id=$1',
      [conversationId, floor, rows.length - remove, bytes],
    );
    await connection.query(
      'DELETE FROM conversation_delivery_events WHERE conversation_id=$1 AND sequence<=$2',
      [conversationId, floor],
    );
  } else {
    await connection.query(
      'UPDATE conversation_delivery_state SET retained_count=$2,retained_bytes=$3 WHERE conversation_id=$1',
      [conversationId, rows.length, bytes],
    );
  }
}

import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { CurrentMessageSource } from '../conversations/message-source.js';
import { MemoryAccessError, type MemoryProjection, type MemoryRow } from './types.js';
export const memoryRowColumns = `m.*,v.id AS version_id,v.confidence,v.source_message_id,v.source_event_id,v.source_creation_event_id,v.source_creation_sequence,u.display_name AS creator_name`;
export const memoryRowTables = `group_memories m JOIN memory_versions v ON v.memory_id=m.id AND v.version=1 JOIN users u ON u.id=m.creator_user_id`;
export function projectCurrentMemory(
  row: MemoryRow,
  source: CurrentMessageSource,
): MemoryProjection {
  if (
    source.versionEventId !== row.source_event_id ||
    source.creationEventId !== row.source_creation_event_id ||
    source.creationSequence !== Number(row.source_creation_sequence)
  )
    throw new MemoryAccessError();
  return {
    id: row.id,
    versionId: row.version_id,
    version: 1,
    scope: { kind: 'group', workspaceId: row.workspace_id, groupId: row.group_id },
    creator: { id: row.creator_user_id, displayName: row.creator_name },
    createdAt: row.created_at,
    confidence: row.confidence,
    confidenceSource: 'human',
    text: source.body,
    source: {
      conversationId: source.conversationId,
      messageId: source.messageId,
      eventId: source.versionEventId,
      creationEventId: source.creationEventId,
      creationSequence: source.creationSequence,
      version: source.version,
      author: source.author,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    },
  };
}

export interface MemorySelectionScope {
  workspaceId: string;
  groupId: string;
  conversationId: string;
  lowerBound: number;
  horizon?: number;
}
// Internal selector. Its caller holds current scope admission and the conversation lock.
// Source eligibility is applied before LIMIT, search, and materialization.
export async function selectCurrentMemoryRows(
  connection: SqlConnection,
  scope: MemorySelectionScope,
  read: { limit: number; after?: string; query?: string },
) {
  const parameters: unknown[] = [
    scope.workspaceId,
    scope.groupId,
    scope.conversationId,
    scope.lowerBound,
    read.limit,
  ];
  let extra = '';
  if (read.after) {
    parameters.push(read.after);
    extra += ` AND m.id>$${parameters.length}`;
  }
  if (scope.horizon !== undefined) {
    parameters.push(scope.horizon);
    extra += ` AND o.sequence<=$${parameters.length}`;
  }
  if (read.query) {
    parameters.push(`%${read.query.replace(/[\\%_]/gu, '\\$&')}%`);
    extra += ` AND e.body ILIKE $${parameters.length}`;
  }
  return (
    await connection.query<MemoryRow>(
      `SELECT ${memoryRowColumns} FROM ${memoryRowTables}
      JOIN conversation_events e ON e.id=v.source_event_id AND e.conversation_id=m.conversation_id AND e.message_id=v.source_message_id
      JOIN conversation_events o ON o.id=v.source_creation_event_id AND o.conversation_id=m.conversation_id AND o.message_id=e.message_id
      LEFT JOIN conversation_events later ON later.conversation_id=e.conversation_id AND later.message_id=e.message_id AND later.sequence>e.sequence
      LEFT JOIN message_purges p ON p.workspace_id=m.workspace_id AND p.conversation_id=m.conversation_id AND p.message_id=e.message_id
      WHERE m.workspace_id=$1 AND m.group_id=$2 AND m.conversation_id=$3 AND o.sequence>=$4
        AND o.event_type IN ('message.created','bot.message.created') AND o.sequence=v.source_creation_sequence
        AND e.event_type IN ('message.created','message.edited','bot.message.created') AND e.body IS NOT NULL
        AND later.id IS NULL AND p.message_id IS NULL${extra} ORDER BY m.id LIMIT $5`,
      parameters,
    )
  ).rows;
}

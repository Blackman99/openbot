import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { CurrentMessageSource } from '../conversations/message-source.js';
import {
  MemoryAccessError,
  type MemoryProjection,
  type MemoryRow,
  type PrivateMemoryProjection,
} from './types.js';
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

export type PrivateMemoryRow = {
  id: string;
  version_id: string;
  workspace_id: string;
  bot_id: string;
  source_group_id: string;
  source_memory_id: string;
  source_memory_version_id: string;
  source_event_id: string;
  source_message_id: string;
  source_conversation_id: string;
  source_creation_event_id: string;
  source_creation_sequence: string | number;
  approver_user_id: string;
  approver_name: string;
  approved_at: Date;
  text: string;
};
export const privateMemoryRowColumns = `p.id,p.version_id,p.workspace_id,p.bot_id,p.source_group_id,p.source_memory_id,p.source_memory_version_id,p.source_event_id,v.source_message_id,m.conversation_id AS source_conversation_id,v.source_creation_event_id,v.source_creation_sequence,p.approver_user_id,u.display_name AS approver_name,p.approved_at,e.body AS text`;
export const privateMemoryRowTables = `bot_private_memories p JOIN memory_versions v ON v.id=p.source_memory_version_id AND v.memory_id=p.source_memory_id JOIN group_memories m ON m.id=p.source_memory_id JOIN users u ON u.id=p.approver_user_id`;
export const privateMemoryCurrentFrom = `${privateMemoryRowTables}
      JOIN conversation_events e ON e.id=v.source_event_id AND e.conversation_id=m.conversation_id AND e.message_id=v.source_message_id
      JOIN conversation_events o ON o.id=v.source_creation_event_id AND o.conversation_id=m.conversation_id AND o.message_id=e.message_id
      LEFT JOIN conversation_events later ON later.conversation_id=e.conversation_id AND later.message_id=e.message_id AND later.sequence>e.sequence
      LEFT JOIN message_purges purge ON purge.workspace_id=m.workspace_id AND purge.conversation_id=m.conversation_id AND purge.message_id=e.message_id`;
export const privateMemoryCurrentWhere = `o.sequence=v.source_creation_sequence
        AND o.event_type IN ('message.created','bot.message.created')
        AND e.event_type IN ('message.created','message.edited','bot.message.created') AND e.body IS NOT NULL
        AND later.id IS NULL AND purge.message_id IS NULL`;
export function projectPrivateMemory(row: PrivateMemoryRow): PrivateMemoryProjection {
  return {
    id: row.id,
    versionId: row.version_id,
    version: 1,
    scope: { kind: 'bot-private', workspaceId: row.workspace_id, botId: row.bot_id },
    sourceGroupId: row.source_group_id,
    sourceMemoryId: row.source_memory_id,
    approver: { id: row.approver_user_id, displayName: row.approver_name },
    approvedAt: row.approved_at,
    text: row.text,
  };
}
export async function selectCurrentPrivateMemoryRows(
  connection: SqlConnection,
  scope: { workspaceId: string; botId: string },
  read: { limit: number; after?: string; query?: string },
) {
  const parameters: unknown[] = [scope.workspaceId, scope.botId, read.limit];
  let extra = '';
  if (read.after) {
    parameters.push(read.after);
    extra += ` AND p.id>$${parameters.length}`;
  }
  if (read.query) {
    parameters.push(`%${read.query.replace(/[\\%_]/gu, '\\$&')}%`);
    extra += ` AND e.body ILIKE $${parameters.length}`;
  }
  return (
    await connection.query<PrivateMemoryRow>(
      `SELECT ${privateMemoryRowColumns} FROM ${privateMemoryCurrentFrom}
      WHERE p.workspace_id=$1 AND p.bot_id=$2 AND ${privateMemoryCurrentWhere}${extra} ORDER BY p.id LIMIT $3`,
      parameters,
    )
  ).rows;
}

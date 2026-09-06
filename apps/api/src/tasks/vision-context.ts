import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { currentPolicy, type CapabilityRecord } from '../providers/capability-policy.js';
import { capabilityExclusion } from '../providers/fallback-policy.js';
import { providerStorage } from '../providers/postgres-provider-scope.js';
import type { ConnectionAccess } from '../providers/scope.js';
import type { ModelImage, VisionMediaType } from '../providers/vision-messages.js';

export async function connectionSupportsVision(
  connection: SqlConnection,
  access: ConnectionAccess,
  connectionId: string,
): Promise<boolean> {
  const { table, key } = providerStorage(access.scope);
  const row = (
    await connection.query<Omit<CapabilityRecord, 'canManage'>>(
      `SELECT metadata,revision,policy FROM ${table} WHERE ${key}=$1 AND id=$2`,
      [access.scope.id, connectionId],
    )
  ).rows[0];
  if (!row) return false;
  return (
    capabilityExclusion(
      { ...row, policy: currentPolicy(row.policy), canManage: false },
      'visionInput',
    ) === null
  );
}

export async function selectCurrentTurnImageMessage(
  connection: SqlConnection,
  filter: { conversationId: string; triggerMessageId: string; triggerSequence: string | number },
): Promise<string> {
  const attached = (
    await connection.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM attachment_objects o
       LEFT JOIN message_purges p ON p.workspace_id=o.workspace_id AND p.conversation_id=o.conversation_id AND p.message_id=o.message_id
       WHERE o.conversation_id=$1 AND o.message_id=$2 AND o.original_id IS NULL AND o.state='live'
         AND o.media_type IN ('image/png','image/jpeg') AND p.message_id IS NULL`,
      [filter.conversationId, filter.triggerMessageId],
    )
  ).rows[0];
  if (Number(attached?.count ?? 0) > 0) return filter.triggerMessageId;
  const previous = (
    await connection.query<{ message_id: string }>(
      `SELECT e.message_id FROM conversation_events e
       WHERE e.conversation_id=$1 AND e.sequence < $2 AND e.event_type='message.created'
       ORDER BY e.sequence DESC LIMIT 1`,
      [filter.conversationId, filter.triggerSequence],
    )
  ).rows[0];
  return previous?.message_id ?? filter.triggerMessageId;
}

export async function selectAuthorizedImageAttachments(
  connection: SqlConnection,
  filter: { workspaceId: string; conversationId: string; messageId: string },
): Promise<
  Array<{
    messageId: string;
    mediaType: VisionMediaType;
    workspaceId: string;
    storageId: string;
    bytes: number;
    sha256: string;
  }>
> {
  const rows = (
    await connection.query<{
      message_id: string;
      media_type: string;
      workspace_id: string;
      storage_id: string;
      bytes: string | number;
      sha256: string;
    }>(
      `SELECT o.message_id,o.media_type,o.workspace_id,o.storage_id,o.bytes,o.sha256 FROM attachment_objects o
       LEFT JOIN message_purges p ON p.workspace_id=o.workspace_id AND p.conversation_id=o.conversation_id AND p.message_id=o.message_id
       WHERE o.workspace_id=$1 AND o.conversation_id=$2 AND o.message_id=$3
         AND o.original_id IS NULL AND o.state='live' AND o.message_id IS NOT NULL
         AND o.media_type IN ('image/png','image/jpeg') AND p.message_id IS NULL
       ORDER BY o.id`,
      [filter.workspaceId, filter.conversationId, filter.messageId],
    )
  ).rows;
  return rows.map((row) => ({
    messageId: row.message_id,
    mediaType: row.media_type as VisionMediaType,
    workspaceId: row.workspace_id,
    storageId: row.storage_id,
    bytes: Number(row.bytes),
    sha256: row.sha256,
  }));
}

export function withImages(
  message: { role: 'system' | 'user' | 'assistant'; content: string },
  images: readonly ModelImage[],
) {
  return images.length ? { ...message, images } : message;
}

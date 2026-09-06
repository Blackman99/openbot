import { createHash } from 'node:crypto';
import {
  conversationUuid,
  type ConversationAccess,
  type MessageCommand,
} from '../conversations/service.js';
export const DEFAULT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export class AttachmentInputError extends Error {}
export class AttachmentUnavailableError extends Error {}
export interface AttachmentMetadata {
  id: string;
  filename: string;
  mediaType: string;
  bytes: number;
}
export interface AttachmentCommand extends MessageCommand {
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}
export type AttachmentRow = {
  id: string;
  storage_id: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string | null;
  actor_user_id: string;
  backend_id: string;
  state: string;
  filename: string;
  media_type: string;
  bytes: number;
  sha256: string;
  lease_until: Date;
  cleanup_after: Date | null;
};
export function attachmentAccess(
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
): ConversationAccess {
  return Object.freeze({
    actorUserId: conversationUuid(actorUserId),
    workspaceId: conversationUuid(workspaceId),
    conversationId: conversationUuid(conversationId),
  });
}
export function attachmentLimit(value: unknown = DEFAULT_ATTACHMENT_BYTES): number {
  const limit = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_ATTACHMENT_BYTES
  )
    throw new AttachmentInputError();
  return limit;
}
export function parseAttachmentCommand(
  value: unknown,
  maximum = DEFAULT_ATTACHMENT_BYTES,
): AttachmentCommand {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'body,bytes,filename,idempotencyKey,mediaType,sha256'
  )
    throw new AttachmentInputError();
  const input = value as Record<string, unknown>;
  if (
    typeof input.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/u.test(input.idempotencyKey) ||
    typeof input.body !== 'string' ||
    !input.body.trim() ||
    input.body.length > 32000 ||
    typeof input.filename !== 'string' ||
    !input.filename ||
    input.filename.normalize('NFC') !== input.filename ||
    Buffer.byteLength(input.filename) > 180 ||
    /[\p{C}<>:"/\\|?*]/u.test(input.filename) ||
    /^[. ]|[. ]$/u.test(input.filename) ||
    typeof input.mediaType !== 'string' ||
    !Number.isSafeInteger(input.bytes) ||
    Number(input.bytes) < 1 ||
    Number(input.bytes) > maximum ||
    typeof input.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.sha256)
  )
    throw new AttachmentInputError();
  return {
    idempotencyKey: input.idempotencyKey,
    body: input.body,
    filename: input.filename,
    mediaType: input.mediaType,
    bytes: Number(input.bytes),
    sha256: input.sha256,
  };
}
export function attachmentCommandHash(command: AttachmentCommand) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: 'message.created',
        body: command.body,
        attachment: {
          filename: command.filename,
          mediaType: command.mediaType,
          bytes: command.bytes,
          sha256: command.sha256,
        },
      }),
    )
    .digest('hex');
}
export function attachmentMetadata(row: AttachmentRow): AttachmentMetadata {
  return { id: row.id, filename: row.filename, mediaType: row.media_type, bytes: row.bytes };
}
export function attachmentDisposition(filename: string) {
  return `attachment; filename="${filename.replace(/[^a-zA-Z0-9._ -]/gu, '_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()]/gu, (v) => '%' + v.charCodeAt(0).toString(16).toUpperCase())}`;
}

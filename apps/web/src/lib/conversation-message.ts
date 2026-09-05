import { parseAttachment } from './attachment-contract.js';
export type MessageAuthor =
  | { id: string; displayName: string }
  | { kind: 'bot'; id: string; displayName: string; versionId: string; versionNumber: number };
export interface MessageProjection {
  attachment?: NonNullable<ReturnType<typeof parseAttachment>>;
  id: string;
  creationSequence: number;
  versionEventId: string;
  sequence: number;
  version: number;
  author: MessageAuthor;
  body: string | null;
  reason: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
  canAudit: boolean;
}
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
function isConversationUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
}
function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function actor(value: unknown) {
  return keys(value, 'displayName,id') &&
    isConversationUuid(value.id) &&
    text(value.displayName, 200)
    ? { id: value.id.toLowerCase(), displayName: value.displayName }
    : undefined;
}
function messageAuthor(value: unknown): MessageAuthor | undefined {
  const person = actor(value);
  if (person) return person;
  if (
    !keys(value, 'displayName,id,kind,versionId,versionNumber') ||
    value.kind !== 'bot' ||
    !isConversationUuid(value.id) ||
    !isConversationUuid(value.versionId) ||
    !positive(value.versionNumber) ||
    !text(value.displayName, 100)
  )
    return undefined;
  return {
    kind: 'bot',
    id: value.id.toLowerCase(),
    displayName: value.displayName,
    versionId: value.versionId.toLowerCase(),
    versionNumber: value.versionNumber,
  };
}
export function parseConversationMessage(value: unknown): MessageProjection | undefined {
  if (
    !keys(
      value,
      (value && typeof value === 'object' && 'attachment' in value ? 'attachment,' : '') +
        'author,body,canAudit,canDelete,canEdit,createdAt,creationSequence,deleted,id,reason,sequence,updatedAt,version,versionEventId',
    ) ||
    !isConversationUuid(value.id) ||
    !isConversationUuid(value.versionEventId) ||
    !positive(value.creationSequence) ||
    !positive(value.sequence) ||
    value.sequence < value.creationSequence ||
    !positive(value.version) ||
    typeof value.deleted !== 'boolean' ||
    !date(value.createdAt) ||
    !date(value.updatedAt) ||
    typeof value.canEdit !== 'boolean' ||
    typeof value.canDelete !== 'boolean' ||
    typeof value.canAudit !== 'boolean'
  )
    return undefined;
  if (
    value.deleted
      ? value.body !== null || !text(value.reason, 500) || value.canEdit || value.canDelete
      : !text(value.body, 32000) || value.reason !== null
  )
    return undefined;
  const attachment = value.attachment === undefined ? undefined : parseAttachment(value.attachment);
  if (value.attachment !== undefined && (!attachment || value.deleted)) return undefined;
  const author = messageAuthor(value.author);
  if (!author || ('kind' in author && (value.canEdit || value.canDelete || value.canAudit)))
    return undefined;
  return {
    ...(attachment ? { attachment } : {}),
    id: value.id.toLowerCase(),
    creationSequence: value.creationSequence,
    versionEventId: value.versionEventId.toLowerCase(),
    sequence: value.sequence,
    version: value.version,
    author,
    body: typeof value.body === 'string' ? value.body : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    deleted: value.deleted,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    canEdit: value.canEdit,
    canDelete: value.canDelete,
    canAudit: value.canAudit,
  };
}

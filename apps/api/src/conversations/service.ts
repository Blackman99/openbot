import type { BotLifecycleState } from '../bots/service.js';
export class ConversationAccessError extends Error {}
export class InvalidConversationInputError extends Error {}
export class ConversationConflictError extends Error {
  constructor(readonly code: 'idempotency_conflict' | 'message_version_conflict') {
    super(code);
  }
}
export interface Conversation {
  botLifecycleState?: BotLifecycleState;
  id: string;
  workspaceId: string;
  subject: ConversationSubject;
  createdAt: Date;
}
export interface ConversationSubject {
  kind: 'group' | 'direct-bot';
  id: string;
}
export interface ConversationAccess {
  actorUserId: string;
  workspaceId: string;
  conversationId: string;
}
export interface MessageCommand {
  idempotencyKey: string;
  body: string;
}
export interface MessageEditCommand extends MessageCommand {
  expectedVersion: number;
}
export interface MessageTombstoneCommand {
  idempotencyKey: string;
  expectedVersion: number;
  reason: string | null;
}
export interface MessageVersion {
  id: string;
  sequence: number;
  type: 'message.created' | 'message.edited' | 'message.deleted';
  version: number;
  actor: { id: string; displayName: string };
  occurredAt: Date;
  body: string | null;
  reason: string | null;
}
export interface MessageReceipt {
  messageId: string;
  eventId: string;
  sequence: number;
}
export interface MessageProjection {
  attachment?: import('../attachments/types.js').AttachmentMetadata;
  id: string;
  creationSequence: number;
  versionEventId: string;
  sequence: number;
  version: number;
  author:
    | { id: string; displayName: string }
    | { kind: 'bot'; id: string; displayName: string; versionId: string; versionNumber: number };
  body: string | null;
  reason: string | null;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  canEdit: boolean;
  canDelete: boolean;
  canAudit: boolean;
}
export interface ConversationPage {
  conversation: Conversation;
  messages: MessageProjection[];
  nextCursor: string | null;
  canWrite: boolean;
}
export interface MessageRead {
  limit: number;
  cursor?: string;
  messageId?: string;
}
export interface ConversationRepository {
  open(
    actorUserId: string,
    workspaceId: string,
    subject: ConversationSubject,
  ): Promise<Conversation>;
  append(access: ConversationAccess, command: MessageCommand): Promise<MessageReceipt>;
  get(access: ConversationAccess, read: MessageRead): Promise<ConversationPage>;
  edit(
    access: ConversationAccess,
    messageId: string,
    command: MessageEditCommand,
  ): Promise<MessageReceipt>;
  versions(access: ConversationAccess, messageId: string): Promise<MessageVersion[]>;
  tombstone(
    access: ConversationAccess,
    messageId: string,
    command: MessageTombstoneCommand,
  ): Promise<MessageReceipt>;
}
export function conversationUuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    throw new InvalidConversationInputError();
  return value.toLowerCase();
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new InvalidConversationInputError();
  return value as Record<string, unknown>;
}
function messageCommand(value: Record<string, unknown>): MessageCommand {
  if (
    typeof value.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey) ||
    typeof value.body !== 'string' ||
    !value.body.trim() ||
    value.body.length > 32000
  )
    throw new InvalidConversationInputError();
  return { idempotencyKey: value.idempotencyKey, body: value.body };
}
function access(
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
): ConversationAccess {
  return {
    actorUserId: conversationUuid(actorUserId),
    workspaceId: conversationUuid(workspaceId),
    conversationId: conversationUuid(conversationId),
  };
}
export function messageRead(query: unknown): MessageRead {
  const value = object(query, ['limit', 'cursor']);
  if (
    value.limit !== undefined &&
    (typeof value.limit !== 'string' ||
      !/^[1-9][0-9]{0,2}$/u.test(value.limit) ||
      Number(value.limit) > 100)
  )
    throw new InvalidConversationInputError();
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(value.cursor))
  )
    throw new InvalidConversationInputError();
  return {
    limit: value.limit === undefined ? 30 : Number(value.limit),
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
  };
}
function conversationRead(query: unknown): MessageRead {
  const { messageId, ...pagination } = object(query, ['limit', 'cursor', 'messageId']);
  if (messageId !== undefined && pagination.cursor !== undefined)
    throw new InvalidConversationInputError();
  return {
    ...messageRead(pagination),
    ...(messageId === undefined ? {} : { messageId: conversationUuid(messageId) }),
  };
}
export class ConversationService {
  constructor(private readonly repository: ConversationRepository) {}
  get(actorUserId: string, workspaceId: string, conversationId: string, query: unknown) {
    return this.repository.get(
      access(actorUserId, workspaceId, conversationId),
      conversationRead(query),
    );
  }
  open(actorUserId: string, workspaceId: string, input: unknown) {
    const value = object(input, ['subject']);
    const subject = object(value.subject, ['kind', 'id']);
    if (subject.kind !== 'group' && subject.kind !== 'direct-bot')
      throw new InvalidConversationInputError();
    return this.repository.open(conversationUuid(actorUserId), conversationUuid(workspaceId), {
      kind: subject.kind,
      id: conversationUuid(subject.id),
    });
  }
  append(actorUserId: string, workspaceId: string, conversationId: string, input: unknown) {
    const value = object(input, ['idempotencyKey', 'body']);
    return this.repository.append(
      access(actorUserId, workspaceId, conversationId),
      messageCommand(value),
    );
  }
  edit(
    actorUserId: string,
    workspaceId: string,
    conversationId: string,
    messageId: string,
    input: unknown,
  ) {
    const value = object(input, ['idempotencyKey', 'body', 'expectedVersion']);
    if (
      typeof value.expectedVersion !== 'number' ||
      !Number.isSafeInteger(value.expectedVersion) ||
      value.expectedVersion < 1
    )
      throw new InvalidConversationInputError();
    return this.repository.edit(
      access(actorUserId, workspaceId, conversationId),
      conversationUuid(messageId),
      { ...messageCommand(value), expectedVersion: value.expectedVersion },
    );
  }
  versions(actorUserId: string, workspaceId: string, conversationId: string, messageId: string) {
    return this.repository.versions(
      access(actorUserId, workspaceId, conversationId),
      conversationUuid(messageId),
    );
  }
  tombstone(
    actorUserId: string,
    workspaceId: string,
    conversationId: string,
    messageId: string,
    input: unknown,
  ) {
    const value = object(input, ['idempotencyKey', 'expectedVersion', 'reason']);
    if (
      typeof value.idempotencyKey !== 'string' ||
      !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey) ||
      typeof value.expectedVersion !== 'number' ||
      !Number.isSafeInteger(value.expectedVersion) ||
      value.expectedVersion < 1 ||
      (value.reason !== undefined &&
        (typeof value.reason !== 'string' ||
          !value.reason.trim() ||
          value.reason.trim().length > 500))
    )
      throw new InvalidConversationInputError();
    return this.repository.tombstone(
      access(actorUserId, workspaceId, conversationId),
      conversationUuid(messageId),
      {
        idempotencyKey: value.idempotencyKey,
        expectedVersion: value.expectedVersion,
        reason: typeof value.reason === 'string' ? value.reason.trim() : null,
      },
    );
  }
}

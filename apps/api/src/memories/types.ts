import { createHash } from 'node:crypto';
import type { CurrentMessageSource } from '../conversations/message-source.js';
export class MemoryAccessError extends Error {}
export class MemoryInputError extends Error {}
export class MemoryConflictError extends Error {
  constructor(readonly code: 'idempotency_conflict' | 'source_version_conflict') {
    super(code);
  }
}
export interface MemoryAccess {
  actorUserId: string;
  workspaceId: string;
  groupId: string;
  grantId?: string;
}
export interface MemoryCommand {
  messageId: string;
  expectedSourceEventId: string;
  confidence: number;
  idempotencyKey: string;
}
export interface MemoryProjection {
  id: string;
  versionId: string;
  version: 1;
  scope: { kind: 'group'; workspaceId: string; groupId: string };
  creator: { id: string; displayName: string };
  createdAt: Date;
  confidence: number;
  confidenceSource: 'human';
  text: string;
  source: {
    conversationId: string;
    messageId: string;
    eventId: string;
    creationEventId: string;
    creationSequence: number;
    version: number;
    author: CurrentMessageSource['author'];
    createdAt: Date;
    updatedAt: Date;
  };
}
export type MemoryRow = {
  id: string;
  version_id: string;
  workspace_id: string;
  group_id: string;
  conversation_id: string;
  creator_user_id: string;
  creator_name: string;
  created_at: Date;
  confidence: number;
  source_message_id: string;
  source_event_id: string;
  source_creation_event_id: string;
  source_creation_sequence: string | number;
  command_hash: string;
};
export function memoryUuid(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input)
  )
    throw new MemoryInputError();
  return input.toLowerCase();
}
export function memoryAccess(supplied: MemoryAccess): Readonly<MemoryAccess> {
  return Object.freeze({
    actorUserId: memoryUuid(supplied.actorUserId),
    workspaceId: memoryUuid(supplied.workspaceId),
    groupId: memoryUuid(supplied.groupId),
    ...(supplied.grantId === undefined ? {} : { grantId: memoryUuid(supplied.grantId) }),
  });
}
export function memoryObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw new MemoryInputError();
  return input as Record<string, unknown>;
}
export function memoryCommand(input: unknown): MemoryCommand {
  const value = memoryObject(input, [
    'messageId',
    'expectedSourceEventId',
    'confidence',
    'idempotencyKey',
  ]);
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey)
  )
    throw new MemoryInputError();
  return {
    messageId: memoryUuid(value.messageId),
    expectedSourceEventId: memoryUuid(value.expectedSourceEventId),
    confidence: value.confidence,
    idempotencyKey: value.idempotencyKey,
  };
}
export function memoryCommandHash(command: MemoryCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: 'memory.create',
        messageId: command.messageId,
        sourceEventId: command.expectedSourceEventId,
        confidence: command.confidence,
      }),
    )
    .digest('hex');
}
export interface MemoryRead {
  query: string;
  limit: number;
  after?: string;
}
export function memoryRead(input: unknown, search: boolean): MemoryRead {
  const value = memoryObject(input, search ? ['query', 'limit', 'after'] : ['limit', 'after']);
  let limit = value.limit;
  if (!search && typeof limit === 'string' && /^[1-9][0-9]{0,2}$/u.test(limit))
    limit = Number(limit);
  if (
    (limit !== undefined &&
      (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) ||
    (search &&
      (typeof value.query !== 'string' ||
        value.query.length > 200 ||
        Buffer.byteLength(value.query) > 800))
  )
    throw new MemoryInputError();
  return {
    query: search ? String(value.query).trim() : '',
    limit: limit === undefined ? 30 : Number(limit),
    ...(value.after === undefined ? {} : { after: memoryUuid(value.after) }),
  };
}

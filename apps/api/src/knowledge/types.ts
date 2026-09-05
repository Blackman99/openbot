import { attachmentAccess } from '../attachments/types.js';
import type { ConversationAccess } from '../conversations/service.js';
import type { KnowledgeChunk, KnowledgeFileKind } from './text-extractor.js';

export class KnowledgeInputError extends Error {
  constructor(
    readonly code: 'unsupported_file' | 'invalid_text' | 'extraction_limit' = 'unsupported_file',
  ) {
    super(code);
  }
}

export class KnowledgeAccessError extends Error {}

export class KnowledgeConflictError extends Error {
  constructor(readonly code: 'idempotency_conflict') {
    super(code);
  }
}

export type KnowledgeScopeKind = 'bot' | 'group' | 'workspace';

export interface KnowledgeScope {
  kind: KnowledgeScopeKind;
  id: string;
}

export interface KnowledgePreview {
  id?: string;
  expiresAt?: Date;
  scope?: KnowledgeScope;
  source: {
    attachmentId: string;
    messageId: string;
    filename: string;
    mediaType: string;
    fileVersion: number;
  };
  kind: KnowledgeFileKind;
  chunks: KnowledgeChunk[];
}

export interface KnowledgeDocument {
  id: string;
  scope: KnowledgeScope;
  source: KnowledgePreview['source'];
  kind: KnowledgeFileKind;
  extractorVersion: string;
  approver: { id: string };
  approvedAt: Date;
  chunks: Array<KnowledgeChunk & { position: number }>;
}

export function knowledgeAccess(
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
): ConversationAccess {
  return attachmentAccess(actorUserId, workspaceId, conversationId);
}

export function knowledgeUuid(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input)
  )
    throw new KnowledgeInputError();
  return input.toLowerCase();
}

function knowledgeObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw new KnowledgeInputError();
  return input as Record<string, unknown>;
}

export function knowledgePreviewInput(input: unknown): KnowledgeScope | undefined {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length === 0
  )
    return undefined;
  const value = knowledgeObject(input, ['scope']);
  return knowledgeScope(value.scope);
}

export function knowledgeScope(input: unknown): KnowledgeScope {
  const value = knowledgeObject(input, ['kind', 'id']);
  if (value.kind !== 'bot' && value.kind !== 'group' && value.kind !== 'workspace')
    throw new KnowledgeInputError();
  return { kind: value.kind, id: knowledgeUuid(value.id) };
}

export function knowledgeConfirmInput(input: unknown): {
  intentId: string;
  idempotencyKey: string;
  acknowledged: true;
} {
  const value = knowledgeObject(input, ['intentId', 'idempotencyKey', 'acknowledged']);
  if (
    value.acknowledged !== true ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey)
  )
    throw new KnowledgeInputError();
  return {
    intentId: knowledgeUuid(value.intentId),
    idempotencyKey: value.idempotencyKey,
    acknowledged: true,
  };
}

import { attachmentAccess } from '../attachments/types.js';
import {
  conversationUuid,
  InvalidConversationInputError,
  type ConversationAccess,
} from '../conversations/service.js';
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
  constructor(readonly code: 'idempotency_conflict' = 'idempotency_conflict') {
    super(code);
  }
}

export type KnowledgeDestination = { kind: 'group' | 'bot' | 'workspace'; id: string };

export interface KnowledgePreview {
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

export function knowledgeAccess(
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
): ConversationAccess {
  return attachmentAccess(actorUserId, workspaceId, conversationId);
}

function knowledgeObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !== keys.slice().sort().join(',')
  )
    throw new KnowledgeInputError();
  return input as Record<string, unknown>;
}

export function knowledgeDestination(input: unknown): KnowledgeDestination {
  const value = knowledgeObject(input, ['kind', 'id']);
  if (value.kind !== 'group' && value.kind !== 'bot' && value.kind !== 'workspace')
    throw new KnowledgeInputError();
  try {
    return { kind: value.kind, id: conversationUuid(value.id) };
  } catch (error) {
    if (error instanceof InvalidConversationInputError) throw new KnowledgeInputError();
    throw error;
  }
}

export function knowledgeWorkspaceAccess(
  actorUserId: string,
  workspaceId: string,
): { actorUserId: string; workspaceId: string } {
  try {
    return {
      actorUserId: conversationUuid(actorUserId),
      workspaceId: conversationUuid(workspaceId),
    };
  } catch (error) {
    if (error instanceof InvalidConversationInputError) throw new KnowledgeInputError();
    throw error;
  }
}

export function knowledgeSearchInput(input: unknown): {
  query: string;
  scope: KnowledgeDestination;
} {
  const value = knowledgeObject(input, ['query', 'scope']);
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 2000)
    throw new KnowledgeInputError();
  return { query: value.query.trim(), scope: knowledgeDestination(value.scope) };
}

export function knowledgePromotionInput(input: unknown): {
  destination: KnowledgeDestination;
  idempotencyKey: string;
  acknowledged: true;
} {
  const value = knowledgeObject(input, ['destination', 'idempotencyKey', 'acknowledged']);
  if (
    value.acknowledged !== true ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey)
  )
    throw new KnowledgeInputError();
  return {
    destination: knowledgeDestination(value.destination),
    idempotencyKey: value.idempotencyKey,
    acknowledged: true,
  };
}

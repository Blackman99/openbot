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

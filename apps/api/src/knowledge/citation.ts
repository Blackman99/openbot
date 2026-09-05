import type { KnowledgeLocatorKind } from './text-extractor.js';

export function knowledgeMatchTerms(body: string): string[] {
  return [...new Set(body.toLowerCase().match(/[a-z0-9]{4,}/gu) ?? [])].slice(0, 16);
}

export function escapeKnowledgeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

export function knowledgeAttachmentHref(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}): string {
  return `/api/v1/workspaces/${input.workspaceId}/conversations/${input.conversationId}/messages/${input.messageId}/attachment`;
}

export function knowledgeAttachmentContentHref(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}): string {
  return `${knowledgeAttachmentHref(input)}/content`;
}

export function knowledgeSourceReference(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  fileVersion: number;
  locator: { kind: KnowledgeLocatorKind; start: number; end: number };
}) {
  return Object.freeze({
    attachmentId: input.attachmentId,
    messageId: input.messageId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    filename: input.filename,
    fileVersion: input.fileVersion,
    locator: Object.freeze({ ...input.locator }),
    href: knowledgeAttachmentHref(input),
    contentHref: knowledgeAttachmentContentHref(input),
  });
}

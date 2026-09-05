import { describe, expect, it } from 'vitest';
import {
  knowledgeAttachmentContentHref,
  knowledgeAttachmentHref,
  knowledgeMatchTerms,
  knowledgeSourceReference,
} from '../../src/knowledge/citation.js';

describe('knowledge citation locators', () => {
  it('builds ATT-01 attachment view and download locators with the chunk file location', () => {
    const source = knowledgeSourceReference({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
      messageId: '33333333-3333-4333-8333-333333333333',
      attachmentId: '44444444-4444-4444-8444-444444444444',
      filename: 'notes.txt',
      fileVersion: 1,
      locator: { kind: 'line', start: 2, end: 2 },
    });
    expect(source.href).toBe(
      knowledgeAttachmentHref({
        workspaceId: source.workspaceId,
        conversationId: source.conversationId,
        messageId: source.messageId,
      }),
    );
    expect(source.contentHref).toBe(
      knowledgeAttachmentContentHref({
        workspaceId: source.workspaceId,
        conversationId: source.conversationId,
        messageId: source.messageId,
      }),
    );
    expect(source.href).toBe(
      '/api/v1/workspaces/11111111-1111-4111-8111-111111111111/conversations/22222222-2222-4222-8222-222222222222/messages/33333333-3333-4333-8333-333333333333/attachment',
    );
    expect(source.contentHref).toBe(`${source.href}/content`);
    expect(source.locator).toEqual({ kind: 'line', start: 2, end: 2 });
    expect(source.fileVersion).toBe(1);
  });

  it('keeps only distinctive terms from a trigger body for scoped matching', () => {
    expect(knowledgeMatchTerms('What is the cobalt key?')).toEqual(['what', 'cobalt']);
    expect(knowledgeMatchTerms('ok')).toEqual([]);
  });
});

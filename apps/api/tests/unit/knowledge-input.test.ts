import { describe, expect, it } from 'vitest';
import {
  KnowledgeInputError,
  knowledgeConfirmInput,
  knowledgePreviewInput,
  knowledgeScope,
} from '../../src/knowledge/types.js';

describe('knowledge promotion input', () => {
  it('treats an empty preview body as extraction-only', () => {
    expect(knowledgePreviewInput({})).toBeUndefined();
    expect(knowledgePreviewInput(undefined)).toBeUndefined();
  });

  it('binds a Bot, group, or Workspace scope on preview', () => {
    expect(
      knowledgePreviewInput({
        scope: { kind: 'group', id: '11111111-1111-4111-8111-111111111111' },
      }),
    ).toEqual({
      kind: 'group',
      id: '11111111-1111-4111-8111-111111111111',
    });
    expect(knowledgeScope({ kind: 'bot', id: '22222222-2222-4222-8222-222222222222' })).toEqual({
      kind: 'bot',
      id: '22222222-2222-4222-8222-222222222222',
    });
    expect(
      knowledgeScope({ kind: 'workspace', id: '33333333-3333-4333-8333-333333333333' }),
    ).toEqual({
      kind: 'workspace',
      id: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('requires an explicit acknowledgement to confirm a preview intent', () => {
    expect(() => knowledgePreviewInput({ destination: { kind: 'group' } })).toThrow(
      KnowledgeInputError,
    );
    expect(() =>
      knowledgeConfirmInput({
        intentId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'confirm-1',
        acknowledged: false,
      }),
    ).toThrow(KnowledgeInputError);
    expect(
      knowledgeConfirmInput({
        intentId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'confirm-1',
        acknowledged: true,
      }),
    ).toEqual({
      intentId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'confirm-1',
      acknowledged: true,
    });
  });
});

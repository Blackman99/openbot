import { describe, expect, it } from 'vitest';
import {
  classifyKnowledgeImage,
  imageKnowledgeChunk,
} from '../../src/knowledge/image-knowledge.js';
import { KnowledgeInputError } from '../../src/knowledge/types.js';

describe('IMG-01 image knowledge descriptions', () => {
  it('accepts only confirmed title and description text and never invents OCR', () => {
    expect(classifyKnowledgeImage('photo.png', 'image/png')).toBe('image');
    expect(classifyKnowledgeImage('notes.pdf', 'application/pdf')).toBeUndefined();
    expect(imageKnowledgeChunk('Cobalt photo', 'Keep the cobalt key', 1)).toEqual({
      text: 'Cobalt photo\nKeep the cobalt key',
      fileVersion: 1,
      locator: { kind: 'line', start: 1, end: 1, ref: 'Cobalt photo' },
    });
    expect(() => imageKnowledgeChunk('  ', 'Keep the cobalt key', 1)).toThrow(KnowledgeInputError);
  });
});

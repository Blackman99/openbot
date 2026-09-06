import { describe, expect, it } from 'vitest';
import { memoryCommand, memoryRead, MemoryInputError } from '../../src/memories/types.js';
const command = {
  messageId: 'b10dbb38-11f4-4b74-bd2a-a1cb798e8101',
  expectedSourceEventId: 'b10dbb38-11f4-4b74-bd2a-a1cb798e8102',
  idempotencyKey: 'save',
  confidence: 0.5,
};
describe('memory command boundary', () => {
  it.each([NaN, Infinity, -Infinity, -0.01, 1.01, '0.5', null])(
    'rejects invalid confidence %s',
    (confidence) => {
      expect(() => memoryCommand({ ...command, confidence })).toThrow(MemoryInputError);
    },
  );
  it.each([0, 0.5, 1])('accepts finite human confidence %s', (confidence) => {
    expect(memoryCommand({ ...command, confidence }).confidence).toBe(confidence);
  });
  it('rejects client-supplied provenance, body, and scope', () => {
    for (const key of ['text', 'scope', 'creator', 'createdAt', 'version', 'source'])
      expect(() => memoryCommand({ ...command, [key]: 'untrusted' })).toThrow(MemoryInputError);
  });
  it('bounds query, page size and scope-independent cursor shape', () => {
    for (const input of [
      { query: 'x'.repeat(201) },
      { query: 'ok', limit: 101 },
      { query: 'ok', after: '../other' },
      { query: 'ok', groupId: command.messageId },
    ])
      expect(() => memoryRead(input, true)).toThrow(MemoryInputError);
    expect(memoryRead({ query: ' cobalt ', limit: 1 }, true)).toEqual({
      query: 'cobalt',
      limit: 1,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { persistTokenUsage, recordTokenUsage } from '../../src/tasks/token-usage.js';

describe('COL-17 token usage classification', () => {
  it('stores provider usage as actual', () => {
    expect(
      recordTokenUsage({
        provider: { inputTokens: 12, outputTokens: 4 },
        localInput: 'ignored prompt',
        localOutput: 'ignored answer',
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 4, estimated: false });
  });

  it('stores a local estimate when the provider omits usage', () => {
    expect(
      recordTokenUsage({
        localInput: 'abcd',
        localOutput: 'abcdefgh',
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, estimated: true });
  });

  it('rejects invalid provider usage instead of estimating', () => {
    expect(
      recordTokenUsage({
        provider: { inputTokens: 1.5, outputTokens: 2 },
        localInput: 'abcd',
        localOutput: 'efgh',
      }),
    ).toBeUndefined();
    expect(
      recordTokenUsage({
        provider: { inputTokens: -1, outputTokens: 2 },
      }),
    ).toBeUndefined();
  });

  it('persists provider usage as actual and local counts as estimated', () => {
    expect(persistTokenUsage({ inputTokens: 12, outputTokens: 4 })).toEqual([12, 4, false]);
    expect(persistTokenUsage({ inputTokens: 8, outputTokens: 2, estimated: true })).toEqual([
      8,
      2,
      true,
    ]);
    expect(persistTokenUsage(null)).toEqual([null, null, null]);
  });
});

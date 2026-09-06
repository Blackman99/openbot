import { describe, expect, it } from 'vitest';
import { parseTask } from '../../src/lib/server/task-contract.js';
import { conversation, task } from '../fixtures/tasks.js';

const tokenBudgets = [
  {
    kind: 'run' as const,
    used: { inputTokens: 12, outputTokens: 0, totalTokens: 12 },
    reserved: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    remaining: { totalTokens: 32756 },
  },
];

describe('COL-17 token budget contract', () => {
  it('accepts used, reserved, and remaining ledgers and rejects a mismatched total', () => {
    const withBudgets = { ...task, tokenBudgets };
    expect(parseTask(withBudgets, conversation.id)).toEqual(withBudgets);
    expect(parseTask(task, conversation.id)).toEqual(task);
    expect(
      parseTask(
        {
          ...task,
          tokenBudgets: [
            { ...tokenBudgets[0]!, used: { inputTokens: 12, outputTokens: 0, totalTokens: 11 } },
          ],
        },
        conversation.id,
      ),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { parseTask } from '../../src/lib/server/task-contract.js';
import { conversation, task } from '../fixtures/tasks.js';

const costBudgets = [
  { kind: 'workspace' as const, usedMicros: 28, reservedMicros: 0, remainingMicros: 72 },
];

describe('COL-18 cost budget contract', () => {
  it('accepts cost ledgers and an unpriced or priced Run', () => {
    const completed = {
      ...task,
      status: 'completed',
      costBudgets,
      runs: [
        {
          ...task.runs[0]!,
          status: 'completed',
          startedAt: '2026-09-05T00:00:01.000Z',
          finishedAt: '2026-09-05T00:00:02.000Z',
          provider: { protocol: 'openai-responses', modelId: 'actual-model' },
          usage: { inputTokens: 12, outputTokens: 0, estimated: false },
          price: { kind: 'unpriced' as const },
          output: {
            messageId: '50000000-0000-4000-8000-000000000005',
            eventId: '60000000-0000-4000-8000-000000000006',
            sequence: 2,
          },
        },
      ],
    };
    expect(parseTask(completed, conversation.id)).toEqual(completed);
    expect(
      parseTask(
        {
          ...completed,
          runs: [{ ...completed.runs[0]!, price: { kind: 'unpriced', extra: true } }],
        },
        conversation.id,
      ),
    ).toBeUndefined();
  });
});

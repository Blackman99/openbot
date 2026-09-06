import { describe, expect, it } from 'vitest';
import { attributedChildResult, inheritChildLimits } from '../../src/tasks/delegate.js';

const GRANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('stricter child limit inheritance', () => {
  const parent = {
    duration: { maxDurationMs: 300_000, source: 'group' as const },
    turns: { maxTurns: 8, source: 'task' as const },
    delegationDepth: { maxDelegationDepth: 2, source: 'workspace' as const },
    handoffs: { maxHandoffs: 3, source: 'group' as const },
  };

  it('takes the tightest remaining parent and Bot caps', () => {
    expect(
      inheritChildLimits({
        parent,
        parentRemainingDurationMs: 90_000,
        bot: { maxDurationSeconds: 300, maxTurns: 8, maxDelegationDepth: 2 },
      }),
    ).toEqual({
      duration: { maxDurationMs: 90_000, source: 'task' },
      turns: { maxTurns: 8, source: 'task' },
      delegationDepth: { maxDelegationDepth: 2, source: 'task' },
      handoffs: { maxHandoffs: 3, source: 'task' },
    });
  });

  it('rejects a child that cannot inherit a positive remaining deadline', () => {
    expect(
      inheritChildLimits({
        parent,
        parentRemainingDurationMs: 0,
        bot: { maxDurationSeconds: 300, maxTurns: 8, maxDelegationDepth: 2 },
      }),
    ).toBeUndefined();
  });
});

describe('attributed child results', () => {
  it('names the child Bot and terminal outcome', () => {
    expect(
      attributedChildResult({
        childTaskId: GRANT,
        botName: 'Researcher',
        outcome: { status: 'completed', body: 'The brief is ready.' },
      }),
    ).toBe(`Delegated child ${GRANT} (Researcher) completed:\nThe brief is ready.`);
    expect(
      attributedChildResult({
        childTaskId: GRANT,
        botName: 'Researcher',
        outcome: { status: 'failed', error: 'provider_failed' },
      }),
    ).toContain('failed: provider_failed');
    expect(
      attributedChildResult({
        childTaskId: GRANT,
        botName: 'Researcher',
        outcome: { status: 'cancelled' },
      }),
    ).toContain('was cancelled');
  });
});

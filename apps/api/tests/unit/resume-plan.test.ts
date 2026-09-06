import { describe, expect, it } from 'vitest';
import { planManualResume } from '../../src/tasks/resume.js';

describe('COL-08 manual resume plan', () => {
  it('feeds the shared next-attempt writer without allocating a second attempt', () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const binding = {
      scope: { kind: 'personal' as const, id: '11111111-1111-4111-8111-111111111111' },
      connectionId: '22222222-2222-4222-8222-222222222222',
      modelId: 'task-model',
    };
    expect(
      planManualResume({
        binding,
        sourceRunId: '33333333-3333-4333-8333-333333333333',
        chainRootRunId: '33333333-3333-4333-8333-333333333333',
        chainAttemptOrdinal: 2,
        chainLimitSnapshot: 4,
        now,
      }),
    ).toEqual({
      origin: 'manual_resume',
      reason: 'manual_resume',
      binding,
      previousBinding: binding,
      notBefore: now,
      delayMs: 0,
      jitterMs: 0,
      chainRootRunId: '33333333-3333-4333-8333-333333333333',
      previousRunId: '33333333-3333-4333-8333-333333333333',
      chainAttemptOrdinal: 2,
      chainLimitSnapshot: 4,
      modelAttemptOrdinal: 1,
    });
  });
});

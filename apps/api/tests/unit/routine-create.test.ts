import { describe, expect, it } from 'vitest';
import { parseCreateRoutineInput, RoutineInputError } from '../../src/routines/service.js';

describe('ROUT-01 create routine input', () => {
  const base = {
    groupId: '11111111-1111-4111-8111-111111111111',
    prompt: 'Run the morning digest.',
    timeZone: 'Asia/Shanghai',
    executeAt: '2026-09-07T01:00:00.000Z',
    expiresAt: '2026-09-08T01:00:00.000Z',
    maxCostMicros: 1_000_000,
  };

  it('accepts lead and group routing policies with IANA time zones', () => {
    expect(parseCreateRoutineInput(base)).toMatchObject({
      groupId: base.groupId,
      prompt: base.prompt,
      timeZone: 'Asia/Shanghai',
      maxCostMicros: 1_000_000,
    });
    expect(
      parseCreateRoutineInput({
        ...base,
        leadGrantId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toMatchObject({
      leadGrantId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('rejects unknown time zones, non-positive budgets, and unknown fields', () => {
    expect(() => parseCreateRoutineInput({ ...base, timeZone: 'Not/AZone' })).toThrow(
      RoutineInputError,
    );
    expect(() => parseCreateRoutineInput({ ...base, maxCostMicros: 0 })).toThrow(RoutineInputError);
    expect(() => parseCreateRoutineInput({ ...base, cron: '* * * * *' })).toThrow(
      RoutineInputError,
    );
  });
});

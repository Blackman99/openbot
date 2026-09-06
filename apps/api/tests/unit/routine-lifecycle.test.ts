import { describe, expect, it } from 'vitest';
import { parseEditRoutineInput, RoutineInputError } from '../../src/routines/service.js';

describe('ROUT-01 edit routine input', () => {
  it('accepts partial schedule edits and lead/group routing switches', () => {
    expect(
      parseEditRoutineInput({
        prompt: 'Updated brief',
        timeZone: 'UTC',
        executeAt: '2026-09-07T04:00:00.000Z',
        expiresAt: '2026-09-08T04:00:00.000Z',
        maxCostMicros: 750_000,
      }),
    ).toMatchObject({
      prompt: 'Updated brief',
      timeZone: 'UTC',
      maxCostMicros: 750_000,
    });
    expect(
      parseEditRoutineInput({
        leadGrantId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toMatchObject({
      leadGrantId: '22222222-2222-4222-8222-222222222222',
    });
    expect(parseEditRoutineInput({ leadGrantId: null })).toMatchObject({
      leadGrantId: null,
    });
  });

  it('rejects empty patches, unknown fields, and invalid budgets or zones', () => {
    expect(() => parseEditRoutineInput({})).toThrow(RoutineInputError);
    expect(() => parseEditRoutineInput({ cron: '* * * * *' })).toThrow(RoutineInputError);
    expect(() => parseEditRoutineInput({ maxCostMicros: 0 })).toThrow(RoutineInputError);
    expect(() => parseEditRoutineInput({ timeZone: 'Not/AZone' })).toThrow(RoutineInputError);
    expect(() =>
      parseEditRoutineInput({ groupId: '11111111-1111-4111-8111-111111111111' }),
    ).toThrow(RoutineInputError);
  });
});

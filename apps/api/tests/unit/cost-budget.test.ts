import { describe, expect, it } from 'vitest';
import {
  EXECUTION_LIMIT_SOFT_DENOMINATOR,
  EXECUTION_LIMIT_SOFT_NUMERATOR,
} from '../../src/tasks/execution-limit-enforcement.js';
import {
  costBudgetFromPolicy,
  costBudgetWarningCrossings,
  evaluateCostReservation,
  evaluateScopedCostReservation,
  projectCostBudgetScope,
  resolveCostBudgets,
} from '../../src/tasks/cost-budget.js';

describe('COL-18 cost reservation math', () => {
  it('reserves micros and reports remaining after used plus reserved', () => {
    expect(
      evaluateCostReservation({
        budget: { maxCostMicros: 100 },
        usedMicros: 10,
        reservedMicros: 20,
        requestMicros: 15,
      }),
    ).toEqual({
      allowed: true,
      hard: false,
      soft: false,
      occupiedMicros: 45,
      remainingMicros: 55,
    });
  });

  it('blocks a reservation race that would exceed a hard cost cap', () => {
    expect(
      evaluateCostReservation({
        budget: { maxCostMicros: 100 },
        usedMicros: 40,
        reservedMicros: 50,
        requestMicros: 11,
      }),
    ).toMatchObject({
      allowed: false,
      hard: true,
      occupiedMicros: 101,
    });
  });

  it('warns at four fifths on lifetime pools and keeps cost off the Run Bot cap', () => {
    expect(EXECUTION_LIMIT_SOFT_NUMERATOR).toBe(4);
    expect(EXECUTION_LIMIT_SOFT_DENOMINATOR).toBe(5);
    expect(
      evaluateCostReservation({
        budget: { maxCostMicros: 100 },
        usedMicros: 70,
        reservedMicros: 0,
        requestMicros: 10,
      }),
    ).toMatchObject({ allowed: true, hard: false, soft: true });
    expect(
      resolveCostBudgets({
        workspace: { maxCostMicros: 200 },
        group: { maxTotalTokens: 80 },
        task: { maxDurationSeconds: 300, maxCostMicros: 50 },
        run: { maxTotalTokens: 14, maxCostMicros: 9 },
      }),
    ).toEqual({
      workspace: { maxCostMicros: 200 },
      task: { maxCostMicros: 50 },
    });
    expect(costBudgetFromPolicy({ maxConcurrentRuns: 4 })).toBeUndefined();
    expect(
      evaluateScopedCostReservation({
        requestMicros: 10,
        scopes: [
          {
            kind: 'workspace',
            budget: { maxCostMicros: 200 },
            usedMicros: 20,
            reservedMicros: 0,
          },
          {
            kind: 'task',
            budget: { maxCostMicros: 15 },
            usedMicros: 6,
            reservedMicros: 0,
          },
        ],
      }),
    ).toMatchObject({
      allowed: false,
      hard: true,
      blocked: { kind: 'task', occupiedMicros: 16 },
    });
  });

  it('projects used, reserved, and remaining cost only when a cap exists', () => {
    expect(
      projectCostBudgetScope(
        'workspace',
        { maxCostMicros: 80 },
        { usedMicros: 20, reservedMicros: 10 },
      ),
    ).toEqual({
      kind: 'workspace',
      usedMicros: 20,
      reservedMicros: 10,
      remainingMicros: 50,
    });
    expect(
      costBudgetWarningCrossings([
        {
          kind: 'workspace',
          allowed: true,
          hard: false,
          soft: true,
          occupiedMicros: 80,
          remainingMicros: 20,
        },
      ]),
    ).toEqual([
      {
        dimension: 'cost',
        used: 80,
        limit: 100,
        source: 'workspace',
        soft: true,
        hard: false,
      },
    ]);
  });
});

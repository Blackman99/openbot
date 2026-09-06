import { describe, expect, it } from 'vitest';
import {
  EXECUTION_LIMIT_SOFT_DENOMINATOR,
  EXECUTION_LIMIT_SOFT_NUMERATOR,
} from '../../src/tasks/execution-limit-enforcement.js';
import {
  evaluateScopedTokenReservation,
  evaluateTokenReservation,
  reconcileTokenReservation,
  resolveTokenBudgets,
  tokenBudgetFromPolicy,
} from '../../src/tasks/token-budget.js';

const budget = { maxInputTokens: 100, maxOutputTokens: 50, maxTotalTokens: 120 };

describe('COL-17 token reservation math', () => {
  it('reserves at every dimension and reports remaining after used plus reserved', () => {
    expect(
      evaluateTokenReservation({
        budget,
        used: { inputTokens: 10, outputTokens: 5 },
        reserved: { inputTokens: 20, outputTokens: 10 },
        request: { inputTokens: 15, outputTokens: 5 },
      }),
    ).toEqual({
      allowed: true,
      hard: false,
      soft: false,
      occupied: { inputTokens: 45, outputTokens: 20, totalTokens: 65 },
      remaining: { inputTokens: 55, outputTokens: 30, totalTokens: 55 },
    });
  });

  it('blocks a reservation race that would exceed a hard total', () => {
    expect(
      evaluateTokenReservation({
        budget,
        used: { inputTokens: 40, outputTokens: 20 },
        reserved: { inputTokens: 40, outputTokens: 10 },
        request: { inputTokens: 10, outputTokens: 5 },
      }),
    ).toMatchObject({
      allowed: false,
      hard: true,
      occupied: { totalTokens: 125 },
    });
  });

  it('warns at four fifths and reconciles reserved tokens to recorded usage', () => {
    expect(EXECUTION_LIMIT_SOFT_NUMERATOR).toBe(4);
    expect(EXECUTION_LIMIT_SOFT_DENOMINATOR).toBe(5);
    expect(
      evaluateTokenReservation({
        budget: { maxTotalTokens: 100 },
        used: { inputTokens: 50, outputTokens: 20 },
        reserved: { inputTokens: 0, outputTokens: 0 },
        request: { inputTokens: 10, outputTokens: 0 },
      }),
    ).toMatchObject({ allowed: true, hard: false, soft: true });
    expect(
      reconcileTokenReservation(
        {
          reserved: { inputTokens: 30, outputTokens: 20 },
          used: { inputTokens: 10, outputTokens: 5 },
        },
        { inputTokens: 12, outputTokens: 4 },
      ),
    ).toEqual({
      reserved: { inputTokens: 0, outputTokens: 0 },
      used: { inputTokens: 22, outputTokens: 9 },
    });
  });

  it('reserves against every applicable scope and keeps token caps off COL-12 snapshots', () => {
    expect(
      resolveTokenBudgets({
        workspace: { maxTotalTokens: 200 },
        group: { maxInputTokens: 80, maxOutputTokens: 40 },
        task: { maxDurationSeconds: 300, maxTotalTokens: 32768 },
      }),
    ).toEqual({
      workspace: { maxTotalTokens: 200 },
      group: { maxInputTokens: 80, maxOutputTokens: 40 },
      task: { maxTotalTokens: 32768 },
    });
    expect(tokenBudgetFromPolicy({ maxConcurrentRuns: 4 })).toEqual({});
    const request = { inputTokens: 10, outputTokens: 5 };
    expect(
      evaluateScopedTokenReservation({
        request,
        scopes: [
          {
            kind: 'workspace',
            budget: { maxTotalTokens: 200 },
            used: { inputTokens: 20, outputTokens: 10 },
            reserved: { inputTokens: 0, outputTokens: 0 },
          },
          {
            kind: 'group',
            budget: { maxInputTokens: 80, maxOutputTokens: 40 },
            used: { inputTokens: 60, outputTokens: 20 },
            reserved: { inputTokens: 10, outputTokens: 10 },
          },
          {
            kind: 'task',
            budget: { maxTotalTokens: 32768 },
            used: { inputTokens: 0, outputTokens: 0 },
            reserved: { inputTokens: 0, outputTokens: 0 },
          },
          {
            kind: 'run',
            budget: { maxTotalTokens: 14 },
            used: { inputTokens: 0, outputTokens: 0 },
            reserved: { inputTokens: 0, outputTokens: 0 },
          },
        ],
      }),
    ).toMatchObject({
      allowed: false,
      hard: true,
      blocked: { kind: 'run', occupied: { totalTokens: 15 } },
    });
  });
});

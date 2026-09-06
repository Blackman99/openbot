import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT_LIMITS } from '../../src/bots/service.js';
import { TaskInputError } from '../../src/tasks/errors.js';
import {
  parseExecutionPolicy,
  resolveExecutionLimits,
  taskPolicyFromBotLimits,
} from '../../src/tasks/execution-limits.js';

describe('COL-12 hierarchical execution limit resolution', () => {
  const task = taskPolicyFromBotLimits(DEFAULT_BOT_LIMITS);

  it('copies Bot limits onto the Task layer without inventing a handoff cap', () => {
    expect(task).toEqual({
      maxDurationSeconds: 300,
      maxTurns: 8,
      maxDelegationDepth: 2,
    });
    expect(resolveExecutionLimits({ task })).toEqual({
      duration: { maxDurationMs: 300_000, source: 'task' },
      turns: { maxTurns: 8, source: 'task' },
      delegationDepth: { maxDelegationDepth: 2, source: 'task' },
    });
  });

  it('selects the strictest present value per dimension and names that layer', () => {
    expect(
      resolveExecutionLimits({
        workspace: {
          maxDurationSeconds: 60,
          maxTurns: 20,
          maxHandoffs: 1,
        },
        group: { maxTurns: 3, maxDelegationDepth: 7, maxHandoffs: 4 },
        task,
        run: { maxDelegationDepth: 0, maxDurationSeconds: 120 },
      }),
    ).toEqual({
      duration: { maxDurationMs: 60_000, source: 'workspace' },
      turns: { maxTurns: 3, source: 'group' },
      delegationDepth: { maxDelegationDepth: 0, source: 'run' },
      handoffs: { maxHandoffs: 1, source: 'workspace' },
    });
  });

  it('attributes a tied value to the most specific layer, not a shared daily quota', () => {
    const workspace = { maxDurationSeconds: 90, maxTurns: 8, maxHandoffs: 2 };
    expect(
      resolveExecutionLimits({
        workspace,
        group: { maxDurationSeconds: 90 },
        task,
      }),
    ).toEqual({
      duration: { maxDurationMs: 90_000, source: 'group' },
      turns: { maxTurns: 8, source: 'task' },
      delegationDepth: { maxDelegationDepth: 2, source: 'task' },
      handoffs: { maxHandoffs: 2, source: 'workspace' },
    });
    expect(resolveExecutionLimits({ workspace, task })).toEqual(
      resolveExecutionLimits({ workspace, task }),
    );
  });

  it('rejects unknown or non-integer policy fields before they can loosen a snapshot', () => {
    expect(parseExecutionPolicy(undefined)).toEqual({});
    expect(parseExecutionPolicy({})).toEqual({});
    expect(parseExecutionPolicy({ maxHandoffs: 0 })).toEqual({ maxHandoffs: 0 });
    expect(() => parseExecutionPolicy({ maxTurns: 1.5 })).toThrow(TaskInputError);
    expect(() => parseExecutionPolicy({ maxDurationSeconds: 0 })).toThrow(TaskInputError);
    expect(() => parseExecutionPolicy({ maxDelegationDepth: -1 })).toThrow(TaskInputError);
    expect(
      parseExecutionPolicy({ maxTotalTokens: 100, maxInputTokens: 80, maxOutputTokens: 40 }),
    ).toEqual({
      maxTotalTokens: 100,
      maxInputTokens: 80,
      maxOutputTokens: 40,
    });
    expect(() => parseExecutionPolicy({ maxTotalTokens: 0 })).toThrow(TaskInputError);
  });
});

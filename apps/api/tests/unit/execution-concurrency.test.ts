import { describe, expect, it } from 'vitest';
import { TaskInputError } from '../../src/tasks/errors.js';
import {
  blockingConcurrencyLayer,
  DEFAULT_GROUP_CONCURRENT_RUNS,
  occupiesConcurrencySlot,
  resolveConcurrencyLimits,
} from '../../src/tasks/execution-concurrency.js';
import { parseExecutionPolicy } from '../../src/tasks/execution-limits.js';

describe('COL-13 concurrency policy and occupancy', () => {
  const now = new Date('2026-09-06T04:00:00.000Z');

  it('defaults a group to four concurrent Runs and keeps workspace and Task child caps independent', () => {
    expect(DEFAULT_GROUP_CONCURRENT_RUNS).toBe(4);
    expect(
      resolveConcurrencyLimits({
        workspace: { maxConcurrentRuns: 8 },
        group: {},
        task: { maxConcurrentRuns: 1 },
      }),
    ).toEqual({
      workspace: { maxConcurrentRuns: 8, source: 'workspace' },
      group: { maxConcurrentRuns: 4, source: 'group' },
      task: { maxConcurrentRuns: 1, source: 'task' },
    });
    expect(
      resolveConcurrencyLimits({
        workspace: {},
        group: { maxConcurrentRuns: 2 },
      }),
    ).toEqual({
      group: { maxConcurrentRuns: 2, source: 'group' },
    });
    expect(resolveConcurrencyLimits({ workspace: {}, group: null })).toEqual({});
  });

  it('accepts maxConcurrentRuns on execution_policy without treating it as a COL-12 budget dimension', () => {
    expect(parseExecutionPolicy({ maxConcurrentRuns: 4, maxTurns: 3 })).toEqual({
      maxConcurrentRuns: 4,
      maxTurns: 3,
    });
    expect(() => parseExecutionPolicy({ maxConcurrentRuns: 0 })).toThrow(TaskInputError);
  });

  it('occupies a slot only for a running Run with a live lease', () => {
    expect(occupiesConcurrencySlot({ status: 'running', leaseExpiresAt: null }, now)).toBe(true);
    expect(
      occupiesConcurrencySlot(
        { status: 'running', leaseExpiresAt: new Date('2026-09-06T04:00:01.000Z') },
        now,
      ),
    ).toBe(true);
    expect(
      occupiesConcurrencySlot(
        { status: 'running', leaseExpiresAt: new Date('2026-09-06T04:00:00.000Z') },
        now,
      ),
    ).toBe(false);
    for (const status of ['queued', 'completed', 'failed', 'paused', 'cancelled'])
      expect(occupiesConcurrencySlot({ status, leaseExpiresAt: null }, now)).toBe(false);
  });

  it('reports the most specific policy layer that is already at its cap', () => {
    const limits = resolveConcurrencyLimits({
      workspace: { maxConcurrentRuns: 8 },
      group: { maxConcurrentRuns: 4 },
      task: { maxConcurrentRuns: 1 },
    });
    expect(blockingConcurrencyLayer(limits, { workspace: 8, group: 4, task: 1 })).toBe('task');
    expect(blockingConcurrencyLayer(limits, { workspace: 3, group: 4, task: 0 })).toBe('group');
    expect(blockingConcurrencyLayer(limits, { workspace: 8, group: 1, task: 0 })).toBe('workspace');
    expect(blockingConcurrencyLayer(limits, { workspace: 3, group: 3, task: 0 })).toBeUndefined();
  });
});

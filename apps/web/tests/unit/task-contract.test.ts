import { describe, expect, it } from 'vitest';
import { parseTask, parseTaskRun } from '../../src/lib/server/task-contract.js';
import { task, conversation } from '../fixtures/tasks.js';

const limits = {
  durationMs: 60_000,
  durationSource: 'workspace' as const,
  turns: 2,
  turnsSource: 'task' as const,
  depth: 2,
  depthSource: 'run' as const,
  handoffs: 8,
  handoffsSource: 'run' as const,
  usage: { durationMs: 0, turns: 0, depth: 0, handoffs: 0 },
  warnings: [
    {
      kind: 'hard_limit' as const,
      dimension: 'turns' as const,
      usage: 0,
      threshold: 0,
      createdAt: '2026-09-06T00:00:00.000Z',
    },
  ],
};

describe('COL-12 Task limit contract', () => {
  it('accepts optional limit snapshots and waiting_budget mismatch', () => {
    expect(parseTask({ ...task, limits }, conversation.id)).toEqual({ ...task, limits });
    const held = {
      ...task,
      status: 'waiting_budget' as const,
      limits,
      runs: [
        {
          ...task.runs[0]!,
          status: 'queued' as const,
        },
      ],
    };
    expect(parseTask(held, conversation.id)).toEqual(held);
    expect(
      parseTaskRun({
        ...task.runs[0]!,
        status: 'waiting_budget',
        finishedAt: '2026-09-06T00:00:01.000Z',
      }),
    ).toMatchObject({ status: 'waiting_budget', finishedAt: '2026-09-06T00:00:01.000Z' });
  });

  it('rejects extra limit fields and unknown sources', () => {
    expect(
      parseTask({ ...task, limits: { ...limits, secret: 'nope' } }, conversation.id),
    ).toBeUndefined();
    expect(
      parseTask({ ...task, limits: { ...limits, durationSource: 'bot' } }, conversation.id),
    ).toBeUndefined();
  });
});

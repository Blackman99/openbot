import { describe, expect, it } from 'vitest';
import { parseTask } from '../../src/lib/server/task-contract.js';
import { conversation, task } from '../fixtures/tasks.js';

const humanRequest = {
  id: '70000000-0000-4000-8000-000000000007',
  kind: 'input' as const,
  prompt: 'What should we keep?',
  responseSchema: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: { note: { type: 'string' as const } },
    required: ['note'],
  },
  createdAt: '2026-09-05T00:00:01.000Z',
};

describe('COL-19 human request contract', () => {
  it('accepts a waiting_input Task with its prompt and schema', () => {
    const waiting = {
      ...task,
      status: 'waiting_input' as const,
      humanRequest,
      runs: [
        {
          ...task.runs[0]!,
          status: 'waiting_input' as const,
          startedAt: '2026-09-05T00:00:01.000Z',
          finishedAt: '2026-09-05T00:00:02.000Z',
          provider: { protocol: 'openai-responses' as const, modelId: 'actual-model' },
        },
      ],
    };
    expect(parseTask(waiting, conversation.id)).toEqual(waiting);
    expect(
      parseTask(
        { ...waiting, humanRequest: { ...humanRequest, kind: 'approval' } },
        conversation.id,
      ),
    ).toBeUndefined();
    expect(parseTask({ ...task, humanRequest }, conversation.id)).toBeUndefined();
  });

  it('accepts a waiting_approval Task with its summary', () => {
    const waiting = {
      ...task,
      status: 'waiting_approval' as const,
      humanRequest: {
        id: humanRequest.id,
        kind: 'approval' as const,
        summary: 'Publish the draft.',
        createdAt: humanRequest.createdAt,
      },
      runs: [
        {
          ...task.runs[0]!,
          status: 'waiting_approval' as const,
          startedAt: '2026-09-05T00:00:01.000Z',
          finishedAt: '2026-09-05T00:00:02.000Z',
          provider: { protocol: 'openai-responses' as const, modelId: 'actual-model' },
        },
      ],
    };
    expect(parseTask(waiting, conversation.id)).toEqual(waiting);
    expect(
      parseTask(
        { ...waiting, humanRequest: { ...waiting.humanRequest, extra: true } },
        conversation.id,
      ),
    ).toBeUndefined();
  });
});

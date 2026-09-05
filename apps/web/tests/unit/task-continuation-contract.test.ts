import { describe, expect, it } from 'vitest';
import { parseRunContinuation, parseTaskRun } from '../../src/lib/server/task-contract.js';
import { parseExecutionState } from '../../src/lib/conversation-stream-contract.js';

const previousRunId = '77777777-7777-4777-8777-777777777777';
const runId = '40000000-0000-4000-8000-000000000004';
const continuation = {
  origin: 'model_fallback' as const,
  reason: 'provider_unavailable' as const,
  previousRunId,
  previousProvider: { protocol: 'openai-chat' as const, modelId: 'primary-model' },
  nextProvider: { protocol: 'openai-chat' as const, modelId: 'fallback-model' },
  dueAt: '2026-09-05T12:00:01.000Z',
  admitted: false,
};
const queuedRun = {
  id: runId,
  attempt: 2,
  status: 'queued' as const,
  createdAt: '2026-09-05T12:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  provider: null,
  usage: null,
  error: null,
  output: null,
  continuation,
};

describe('COL-10 fallback continuation contract', () => {
  it('accepts a planned fallback and rejects secrets or unknown reasons', () => {
    expect(parseRunContinuation(continuation)).toEqual(continuation);
    expect(parseTaskRun(queuedRun)).toEqual(queuedRun);
    expect(
      parseRunContinuation({
        ...continuation,
        previousProvider: { ...continuation.previousProvider, connectionId: previousRunId },
      }),
    ).toBeUndefined();
    expect(
      parseRunContinuation({
        ...continuation,
        nextProvider: { ...continuation.nextProvider, endpoint: 'https://secret.example' },
      }),
    ).toBeUndefined();
    expect(parseRunContinuation({ ...continuation, reason: 'provider_failed' })).toBeUndefined();
    expect(
      parseTaskRun({ ...queuedRun, continuation: { ...continuation, admitted: 'yes' } }),
    ).toBeUndefined();
  });

  it('keeps historical runs without continuation and names previous and next models on the stream', () => {
    const { continuation: _ignored, ...legacy } = queuedRun;
    expect(parseTaskRun(legacy)).toEqual(legacy);
    const execution = {
      taskId: '55555555-5555-4555-8555-555555555555',
      runId,
      attempt: 2,
      taskStatus: 'running' as const,
      runStatus: 'running' as const,
      bot: {
        id: '20000000-0000-4000-8000-000000000002',
        displayName: 'Research',
        versionId: '30000000-0000-4000-8000-000000000003',
        versionNumber: 1,
      },
      executionUser: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Owner' },
      createdAt: '2026-09-05T12:00:00.000Z',
      startedAt: '2026-09-05T12:00:01.000Z',
      finishedAt: null,
      provider: { protocol: 'openai-chat' as const, modelId: 'fallback-model' },
      usage: null,
      error: null,
      output: null,
      continuation: { ...continuation, admitted: true },
    };
    expect(parseExecutionState(execution)).toEqual(execution);
    expect(
      parseExecutionState({
        ...execution,
        continuation: { ...continuation, previousBinding: { connectionId: previousRunId } },
      }),
    ).toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { TaskApiClient } from '../../src/lib/server/task-api.js';
import { task, conversation, workspace, token } from '../fixtures/tasks.js';

const run2 = '70000000-0000-4000-8000-000000000007';
const run3 = '80000000-0000-4000-8000-000000000008';
const queued2 = {
  ...task,
  runCount: 2,
  olderRunsCursor: 'older_attempt_1',
  runs: [{ ...task.runs[0], id: run2, attempt: 2 }],
};
const command = { idempotencyKey: 'exact-retry-command', expectedRunId: task.runs[0]!.id };
const failed1 = {
  ...task.runs[0],
  status: 'failed',
  finishedAt: '2026-09-05T00:00:01.000Z',
  error: 'execution_forbidden',
};
function client(payload: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
  return { request, api: new TaskApiClient(request, 'http://api:3001', 'http://localhost:3000') };
}

describe('Task retry and history client', () => {
  it('sends the exact retry identity and reads its stable receipt alongside a later current attempt', async () => {
    const saved = {
      task: { ...queued2, runCount: 3, runs: [{ ...queued2.runs[0], id: run3, attempt: 3 }] },
      receipt: { runId: run2, attempt: 2 },
    };
    const { api, request } = client(saved, 202);
    expect(await api.retry(token, workspace.id, conversation.id, task.id, command)).toEqual({
      status: 'available',
      value: saved,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}/retries`,
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify(command),
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
    });
  });

  it.each([
    { runId: run2, attempt: 1 },
    { runId: run2, attempt: 3 },
    { runId: run3, attempt: 2 },
    { runId: task.runs[0]!.id, attempt: 2 },
    { runId: run2, attempt: 2, diagnostic: 'private' },
  ])('rejects a retry response with contradictory or expanded receipt %j', async (receipt) => {
    const { api } = client({ task: queued2, receipt }, 202);
    expect(await api.retry(token, workspace.id, conversation.id, task.id, command)).toEqual({
      status: 'unavailable',
    });
  });

  it.each([
    ['task_retry_state_conflict', 'retry-state-conflict'],
    ['task_retry_run_conflict', 'retry-run-conflict'],
    ['task_attempt_exhausted', 'attempt-exhausted'],
  ])('maps the safe 409 %s response to %s', async (code, status) => {
    const { api } = client({ error: { code } }, 409);
    expect(await api.retry(token, workspace.id, conversation.id, task.id, command)).toEqual({
      status,
    });
  });

  it('reads preserved failed attempts through a bounded scoped GET without execution admission', async () => {
    const saved = {
      conversationId: conversation.id,
      taskId: task.id,
      runs: [failed1],
      nextCursor: null,
    };
    const { api, request } = client(saved);
    expect(
      await api.runs(token, workspace.id, conversation.id, task.id, {
        cursor: 'older_attempt_1',
        limit: 20,
      }),
    ).toEqual({ status: 'available', value: saved });
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}/runs?cursor=older_attempt_1&limit=20`,
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(request.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it.each([
    { runs: [failed1, failed1], nextCursor: null },
    { runs: [failed1, { ...failed1, id: run2, attempt: 2 }], nextCursor: null },
    { runs: [], nextCursor: 'endless_cursor' },
    { runs: [{ ...failed1, apiKey: 'private' }], nextCursor: null },
    { runs: [failed1], nextCursor: '../invalid' },
  ])('rejects inconsistent history %j', async (page) => {
    const { api } = client({ conversationId: conversation.id, taskId: task.id, ...page });
    expect(await api.runs(token, workspace.id, conversation.id, task.id)).toEqual({
      status: 'unavailable',
    });
  });
});

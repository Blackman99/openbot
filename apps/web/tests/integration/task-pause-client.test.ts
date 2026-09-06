import { describe, expect, it, vi } from 'vitest';
import { TaskApiClient } from '../../src/lib/server/task-api.js';
import { task, conversation, workspace, token } from '../fixtures/tasks.js';

const at = '2026-09-05T00:00:01.000Z';
const command = { idempotencyKey: 'unchanged-pause', expectedRunId: task.runs[0]!.id };
const paused = {
  ...task,
  status: 'paused' as const,
  runs: [{ ...task.runs[0], status: 'paused' as const, finishedAt: at }],
};
const pause = {
  commandId: '90000000-0000-4000-8000-000000000009',
  taskId: task.id,
  rootTaskId: task.id,
  runId: command.expectedRunId,
  attempt: 1,
  checkpointId: '90000000-0000-4000-8000-00000000000a',
  pausedAt: at,
  affectedTaskCount: 1,
  affectedRunCount: 1,
};
const nextRun = '80000000-0000-4000-8000-000000000008';
const resume = {
  commandId: '90000000-0000-4000-8000-00000000000b',
  taskId: task.id,
  runId: nextRun,
  attempt: 2,
  sourceRunId: command.expectedRunId,
  checkpointId: pause.checkpointId,
  resumedAt: '2026-09-05T00:00:02.000Z',
  affectedTaskCount: 1,
  affectedRunCount: 1,
};
function client(payload: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
  return { request, api: new TaskApiClient(request, 'http://api:3001', 'http://localhost:3000') };
}
describe('Task pause and resume client', () => {
  it('sends one unchanged pause command and accepts its exact paused receipt', async () => {
    const saved = { task: paused, pause },
      { api, request } = client(saved);
    expect(await api.pause(token, workspace.id, conversation.id, task.id, command)).toEqual({
      status: 'available',
      value: saved,
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}/pauses`,
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(command),
    });
  });
  it('sends one unchanged resume command and accepts its new attempt receipt', async () => {
    const saved = {
      task: {
        ...task,
        runCount: 2,
        olderRunsCursor: 'older_attempt',
        runs: [{ ...task.runs[0], id: nextRun, attempt: 2 }],
      },
      resume,
    };
    const { api, request } = client(saved, 202);
    expect(await api.resume(token, workspace.id, conversation.id, task.id, command)).toEqual({
      status: 'available',
      value: saved,
    });
    expect(String(request.mock.calls[0]?.[0])).toContain('/resumes');
  });
  it.each([
    ['task_pause_state_conflict', 'pause-state-conflict'],
    ['task_pause_run_conflict', 'pause-run-conflict'],
  ])('maps pause HTTP 409/%s', async (code, status) => {
    expect(
      await client({ error: { code } }, 409).api.pause(
        token,
        workspace.id,
        conversation.id,
        task.id,
        command,
      ),
    ).toEqual({ status });
  });
  it.each([
    ['task_resume_state_conflict', 'resume-state-conflict'],
    ['task_resume_run_conflict', 'resume-run-conflict'],
    ['task_resume_paused_ancestor', 'resume-paused-ancestor'],
  ])('maps resume HTTP 409/%s', async (code, status) => {
    expect(
      await client({ error: { code } }, 409).api.resume(
        token,
        workspace.id,
        conversation.id,
        task.id,
        command,
      ),
    ).toEqual({ status });
  });
});

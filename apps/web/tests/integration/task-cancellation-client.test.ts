import { describe, expect, it, vi } from 'vitest';
import { TaskApiClient } from '../../src/lib/server/task-api.js';
import { task, conversation, workspace, token } from '../fixtures/tasks.js';

const at = '2026-09-05T00:00:01.000Z';
const command = { idempotencyKey: 'unchanged-stop', expectedRunId: task.runs[0]!.id };
const cancelled = {
  ...task,
  status: 'cancelled',
  runs: [{ ...task.runs[0], status: 'cancelled', finishedAt: at }],
};
const receipt = {
  commandId: '90000000-0000-4000-8000-000000000009',
  taskId: task.id,
  rootTaskId: task.id,
  runId: command.expectedRunId,
  attempt: 1,
  cancelledAt: at,
  affectedTaskCount: 1,
  affectedRunCount: 1,
};
function client(payload: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
  return { request, api: new TaskApiClient(request, 'http://api:3001', 'http://localhost:3000') };
}
describe('Task cancellation and retained partial client', () => {
  it('sends one unchanged cancellation command and accepts its exact cancelled receipt', async () => {
    const saved = { task: cancelled, receipt },
      { api, request } = client(saved);
    expect(await api.cancel(token, workspace.id, conversation.id, task.id, command)).toEqual({
      status: 'available',
      value: saved,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}/cancellations`,
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(command),
      redirect: 'error',
    });
  });
  it.each([
    { ...receipt, runId: '80000000-0000-4000-8000-000000000008' },
    { ...receipt, affectedRunCount: 2 },
    { ...receipt, attempt: 2 },
    { ...receipt, cancelledAt: '2026-09-05T00:00:02.000Z' },
    { ...receipt, diagnostic: 'provider-secret' },
  ])('rejects an expanded or inconsistent cancellation receipt %j', async (bad) => {
    expect(
      await client({ task: cancelled, receipt: bad }).api.cancel(
        token,
        workspace.id,
        conversation.id,
        task.id,
        command,
      ),
    ).toEqual({ status: 'unavailable' });
  });
  it('accepts a zero-effect new-key receipt and rejects an accidental accepted/queued response', async () => {
    const saved = {
      task: cancelled,
      receipt: { ...receipt, affectedTaskCount: 0, affectedRunCount: 0 },
    };
    expect(
      (await client(saved).api.cancel(token, workspace.id, conversation.id, task.id, command))
        .status,
    ).toBe('available');
    expect(
      (await client(saved, 202).api.cancel(token, workspace.id, conversation.id, task.id, command))
        .status,
    ).toBe('unavailable');
    expect(
      (
        await client({ task, receipt }).api.cancel(
          token,
          workspace.id,
          conversation.id,
          task.id,
          command,
        )
      ).status,
    ).toBe('unavailable');
  });
  it('reads a complete interrupted UTF-8 prefix by exact Task and Run without executing anything', async () => {
    const text = 'Stopped 🌲',
      saved = {
        conversationId: conversation.id,
        taskId: task.id,
        runId: command.expectedRunId,
        partial: { text, endByte: new TextEncoder().encode(text).byteLength, interrupted: true },
      };
    const { api, request } = client(saved);
    expect(
      await api.partialOutput(token, workspace.id, conversation.id, task.id, command.expectedRunId),
    ).toEqual({ status: 'available', value: saved });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(request.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(
      (
        await client({ ...saved, partial: { ...saved.partial, endByte: 1 } }).api.partialOutput(
          token,
          workspace.id,
          conversation.id,
          task.id,
          command.expectedRunId,
        )
      ).status,
    ).toBe('unavailable');
    expect(
      (
        await client({
          ...saved,
          partial: { ...saved.partial, interrupted: false },
        }).api.partialOutput(token, workspace.id, conversation.id, task.id, command.expectedRunId)
      ).status,
    ).toBe('unavailable');
    expect(
      (
        await client({
          ...saved,
          partial: { ...saved.partial, secret: 'hidden' },
        }).api.partialOutput(token, workspace.id, conversation.id, task.id, command.expectedRunId)
      ).status,
    ).toBe('unavailable');
  });
});

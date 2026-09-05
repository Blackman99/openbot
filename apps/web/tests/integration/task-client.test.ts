import { describe, expect, it, vi } from 'vitest';
import { TaskApiClient } from '../../src/lib/server/task-api.js';
import { task, conversation, workspace, token } from '../fixtures/tasks.js';
describe('Task API client', () => {
  it('does not send a task request after the page request has already been aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const request = vi.fn(async () => Response.json({ task }));
    const client = new TaskApiClient(
      request,
      'http://api:3001',
      'http://localhost:3000',
      abort.signal,
    );
    expect(await client.get(token, workspace.id, conversation.id, task.id)).toEqual({
      status: 'unavailable',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels response consumption when the page request disconnects', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let source: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode('{"task":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new TaskApiClient(
      vi.fn(async () => new Response(body)),
      'http://api:3001',
      'http://localhost:3000',
      abort.signal,
    );
    const pending = client.get(token, workspace.id, conversation.id, task.id);
    try {
      await vi.advanceTimersByTimeAsync(1);
      abort.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(cancelled).toBe(true);
      expect(await pending).toEqual({ status: 'unavailable' });
    } finally {
      if (!cancelled) source!.error(new Error('test_cleanup'));
      await pending;
      vi.useRealTimers();
    }
  });

  it('cancels a stalled response body when the request deadline expires', async () => {
    vi.useFakeTimers();
    let source: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode('{"task":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new TaskApiClient(
      vi.fn(async () => new Response(body)),
      'http://api:3001',
      'http://localhost:3000',
    );
    const pending = client.get(token, workspace.id, conversation.id, task.id);
    try {
      await vi.advanceTimersByTimeAsync(30001);
      expect(cancelled).toBe(true);
      expect(await pending).toEqual({ status: 'unavailable' });
    } finally {
      if (!cancelled) source!.error(new Error('test_cleanup'));
      await pending;
      vi.useRealTimers();
    }
  });

  it.each([
    [401, 'authentication_required', 'anonymous'],
    [403, 'task_forbidden', 'forbidden'],
    [403, 'invalid_origin', 'forbidden'],
    [400, 'invalid_task_request', 'invalid'],
    [413, 'invalid_task_request', 'invalid'],
    [409, 'idempotency_conflict', 'idempotency-conflict'],
    [409, 'task_model_unavailable', 'model-unavailable'],
    [503, 'authentication_required', 'unavailable'],
    [403, 'authentication_required', 'unavailable'],
  ] as const)('maps HTTP %s with code %s to the safe result %s', async (status, code, expected) => {
    const client = new TaskApiClient(
      vi.fn(async () => Response.json({ error: { code } }, { status })),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.get(token, workspace.id, conversation.id, task.id)).toEqual({
      status: expected,
    });
  });

  it.each(['completed', 'running', 'failed'] as const)(
    'reloads a %s task and its actual attempt through read-only list and detail requests',
    async (status) => {
      const completed = {
        ...task,
        status: 'completed',
        runs: [
          {
            ...task.runs[0],
            status: 'completed',
            startedAt: '2026-09-05T00:00:01.000Z',
            finishedAt: '2026-09-05T00:00:02.000Z',
            provider: { protocol: 'anthropic-messages', modelId: 'actual-model' },
            usage: { inputTokens: 100, outputTokens: 20 },
            output: {
              messageId: '50000000-0000-4000-8000-000000000005',
              eventId: '60000000-0000-4000-8000-000000000006',
              sequence: 2,
            },
          },
        ],
      };
      const stored =
        status === 'completed'
          ? completed
          : {
              ...completed,
              status,
              runs: [
                {
                  ...completed.runs[0],
                  status,
                  finishedAt: status === 'running' ? null : completed.runs[0].finishedAt,
                  output: null,
                  error: status === 'failed' ? 'provider_failed' : null,
                },
              ],
            };
      const saved = {
        conversationId: conversation.id,
        tasks: [stored],
        nextCursor: 'opaque_next-1',
      };
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(saved))
        .mockResolvedValueOnce(Response.json({ task: stored }));
      expect(
        await new TaskApiClient(request, 'http://api:3001', 'http://localhost:3000').list(
          token,
          workspace.id,
          conversation.id,
          { limit: 20 },
        ),
      ).toEqual({ status: 'available', value: saved });
      expect(
        await new TaskApiClient(request, 'http://api:3001', 'http://localhost:3000').get(
          token,
          workspace.id,
          conversation.id,
          task.id.toUpperCase(),
        ),
      ).toEqual({ status: 'available', value: stored });
      expect(request).toHaveBeenCalledTimes(2);
      for (const call of request.mock.calls) {
        expect(call[1]?.method).toBe('GET');
        expect(call[1]?.headers).not.toHaveProperty('content-type');
        expect(call[1]?.body).toBeUndefined();
      }
    },
  );

  it('rejects a response exceeding its byte budget even when its JSON is otherwise valid', async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(' '.repeat(1024 * 1024) + JSON.stringify({ task }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new TaskApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(
      await client.submit(token, workspace.id, conversation.id, {
        idempotencyKey: 'bounded-task',
        body: 'Compare the evidence.',
      }),
    ).toEqual({ status: 'unavailable' });
  });

  it('submits one durable task command and accepts the queued receipt', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ task }, { status: 202 }));
    const client = new TaskApiClient(request, 'http://api:3001/', 'http://localhost:3000');
    expect(
      await client.submit(token, workspace.id.toUpperCase(), conversation.id.toUpperCase(), {
        idempotencyKey: 'task-command-1',
        body: 'Compare the evidence.',
      }),
    ).toEqual({ status: 'available', value: task });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/tasks`,
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'task-command-1', body: 'Compare the evidence.' }),
    });
  });
});

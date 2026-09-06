import { describe, expect, it, vi } from 'vitest';
import {
  loadTasksPage,
  loadTaskPage,
  loadTaskRunsPage,
  submitTask,
  retryTask,
  cancelTask,
  pauseTask,
  resumeTask,
} from '../../src/lib/server/task-page.js';
import { task, conversation, workspace, user, token } from '../fixtures/tasks.js';
import { page } from '../fixtures/conversations.js';
import { grant, membership } from '../fixtures/group-bots.js';

function context() {
  const currentGrant = {
    ...grant,
    conversationId: conversation.id,
    bot: { ...grant.bot, canInspect: false },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith('/tasks'))
      return Response.json({
        conversationId: conversation.id,
        tasks: [{ ...task, groupGrantId: grant.id }],
        nextCursor: 'next_task-page',
      });
    if (path.endsWith(`/groups/${conversation.subject.id}/bots`))
      return Response.json({ ...membership, canManage: false, grants: [currentGrant] });
    if (path.endsWith(`/conversations/${conversation.id}`))
      return Response.json({ ...page, messages: [], nextCursor: null });
    throw new Error('unexpected_request');
  });
  const url = new URL(
    `http://localhost:3000/app/workspaces/${workspace.id}/conversations/${conversation.id}/tasks?cursor=task_cursor&limit=5`,
  );
  return {
    fetch,
    cookies: {
      get: vi.fn(() => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
    setHeaders: vi.fn(),
    url,
    request: new Request(url),
  };
}

describe('Task page boundary', () => {
  it('preserves an unknown cancellation outcome and confirms the identical command without creating a retry', async () => {
    const event = context(),
      values = { idempotencyKey: 'uncertain-cancel', expectedRunId: task.runs[0]!.id };
    const cancelledAt = '2026-09-05T00:00:01.000Z';
    const saved = {
      task: {
        ...task,
        status: 'cancelled',
        runs: [{ ...task.runs[0], status: 'cancelled', finishedAt: cancelledAt }],
      },
      receipt: {
        commandId: grant.id,
        taskId: task.id,
        rootTaskId: task.id,
        runId: values.expectedRunId,
        attempt: 1,
        cancelledAt,
        affectedTaskCount: 1,
        affectedRunCount: 1,
      },
    };
    event.fetch
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'task_unavailable' } }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(saved));
    const request = () =>
      new Request(event.url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams(values),
      });
    expect(
      await cancelTask({ ...event, request: request() }, workspace.id, conversation.id, task.id),
    ).toMatchObject({
      status: 503,
      data: { cancellation: { values, uncertain: true, conflict: false } },
    });
    await expect(
      cancelTask({ ...event, request: request() }, workspace.id, conversation.id, task.id),
    ).rejects.toMatchObject({
      status: 303,
      location: `/app/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}`,
    });
    expect(event.fetch.mock.calls).toHaveLength(2);
    for (const [url, init] of event.fetch.mock.calls) {
      expect(String(url)).toContain('/cancellations');
      expect(JSON.parse(String(init?.body))).toEqual(values);
    }
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });
  it('preserves an unknown pause outcome and confirms the identical command', async () => {
    const event = context(),
      values = { idempotencyKey: 'uncertain-pause', expectedRunId: task.runs[0]!.id };
    const pausedAt = '2026-09-05T00:00:01.000Z';
    const saved = {
      task: {
        ...task,
        status: 'paused',
        runs: [{ ...task.runs[0], status: 'paused', finishedAt: pausedAt }],
      },
      pause: {
        commandId: grant.id,
        taskId: task.id,
        rootTaskId: task.id,
        runId: values.expectedRunId,
        attempt: 1,
        checkpointId: grant.id,
        pausedAt,
        affectedTaskCount: 1,
        affectedRunCount: 1,
      },
    };
    event.fetch
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'task_unavailable' } }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(saved));
    const request = () =>
      new Request(event.url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams(values),
      });
    expect(
      await pauseTask({ ...event, request: request() }, workspace.id, conversation.id, task.id),
    ).toMatchObject({
      status: 503,
      data: { pause: { values, uncertain: true, conflict: false } },
    });
    await expect(
      pauseTask({ ...event, request: request() }, workspace.id, conversation.id, task.id),
    ).rejects.toMatchObject({
      status: 303,
      location: `/app/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}`,
    });
    for (const [url, init] of event.fetch.mock.calls) {
      expect(String(url)).toContain('/pauses');
      expect(JSON.parse(String(init?.body))).toEqual(values);
    }
  });
  it('preserves an unknown resume outcome and confirms the identical new attempt', async () => {
    const event = context(),
      values = { idempotencyKey: 'uncertain-resume', expectedRunId: task.runs[0]!.id };
    const resumedAt = '2026-09-05T00:00:02.000Z';
    const nextRun = '80000000-0000-4000-8000-000000000008';
    const saved = {
      task: {
        ...task,
        runCount: 2,
        olderRunsCursor: 'older_attempt',
        runs: [{ ...task.runs[0], id: nextRun, attempt: 2 }],
      },
      resume: {
        commandId: grant.id,
        taskId: task.id,
        runId: nextRun,
        attempt: 2,
        sourceRunId: values.expectedRunId,
        checkpointId: grant.id,
        resumedAt,
        affectedTaskCount: 1,
        affectedRunCount: 1,
      },
    };
    event.fetch
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'task_unavailable' } }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(saved, { status: 202 }));
    const request = () =>
      new Request(event.url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams(values),
      });
    expect(
      await resumeTask({ ...event, request: request() }, workspace.id, conversation.id, task.id),
    ).toMatchObject({
      status: 503,
      data: { resume: { values, uncertain: true, conflict: false } },
    });
    await expect(
      resumeTask({ ...event, request: request() }, workspace.id, conversation.id, task.id),
    ).rejects.toMatchObject({
      status: 303,
      location: `/app/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}`,
    });
    for (const [url, init] of event.fetch.mock.calls) {
      expect(String(url)).toContain('/resumes');
      expect(JSON.parse(String(init?.body))).toEqual(values);
    }
  });
  it('loads a planned fallback with previous model, next model and reason and drops secrets', async () => {
    const event = context(),
      original = event.fetch.getMockImplementation()!;
    const continuation = {
      origin: 'model_fallback',
      reason: 'provider_unavailable',
      previousRunId: task.runs[0]!.id,
      previousProvider: { protocol: 'openai-chat', modelId: 'primary-model' },
      nextProvider: { protocol: 'openai-chat', modelId: 'fallback-model' },
      dueAt: '2026-09-05T00:00:01.000Z',
      admitted: false,
    };
    event.fetch.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/tasks/${task.id}`))
        return Response.json({
          task: {
            ...task,
            runCount: 2,
            olderRunsCursor: 'older_attempt',
            runs: [{ ...task.runs[0], attempt: 2, continuation }],
          },
        });
      return original(url, init);
    });
    expect(await loadTaskPage(event, workspace.id, conversation.id, task.id)).toMatchObject({
      task: {
        runCount: 2,
        runs: [
          {
            attempt: 2,
            continuation: {
              origin: 'model_fallback',
              reason: 'provider_unavailable',
              previousProvider: { protocol: 'openai-chat', modelId: 'primary-model' },
              nextProvider: { protocol: 'openai-chat', modelId: 'fallback-model' },
              admitted: false,
            },
          },
        ],
      },
      canRetry: false,
    });
    expect(JSON.stringify(event.fetch.mock.calls)).not.toMatch(/connectionId|baseUrl|apiKey/u);
  });

  it('offers cancellation to a current group admin with inspect access even when writing is unavailable', async () => {
    const event = context(),
      original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/tasks/${task.id}`))
        return Response.json({
          task: {
            ...task,
            executionUser: { ...task.executionUser, id: grant.id },
            groupGrantId: grant.id,
          },
        });
      if (path.endsWith(`/conversations/${conversation.id}`))
        return Response.json({ ...page, canWrite: false, messages: [], nextCursor: null });
      if (path.endsWith(`/groups/${conversation.subject.id}`))
        return Response.json({
          group: {
            id: conversation.subject.id,
            workspaceId: workspace.id,
            name: 'Group',
            description: '',
            visibility: 'private',
            role: 'admin',
            createdAt: conversation.createdAt,
            updatedAt: conversation.createdAt,
          },
        });
      if (path.includes('/bots') || path.includes('model-connections'))
        throw new Error('cancel_does_not_require_model_use');
      return original(url, init);
    });
    expect(await loadTaskPage(event, workspace.id, conversation.id, task.id)).toMatchObject({
      canCancel: true,
      canPause: true,
      canResume: false,
      canRetry: false,
      partialOutput: null,
    });
  });
  it('omits the automatic group choice from the API command and retains it when no candidate is available', async () => {
    const event = context();
    const values = {
      idempotencyKey: 'automatic-choice',
      body: 'Find the right helper',
      groupGrantId: '',
    };
    const request = () =>
      new Request(event.url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams(values),
      });
    event.fetch
      .mockResolvedValueOnce(Response.json({ error: { code: 'no_eligible_bot' } }, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            task: {
              ...task,
              groupGrantId: grant.id,
              routing: { algorithm: 'local-terms-v1', reason: 'local-match' },
            },
          },
          { status: 202 },
        ),
      );
    expect(
      await submitTask({ ...event, request: request() }, workspace.id, conversation.id),
    ).toMatchObject({
      status: 409,
      data: {
        values,
        uncertain: false,
        conflict: false,
        error: expect.stringContaining('No group Bot'),
      },
    });
    await expect(
      submitTask({ ...event, request: request() }, workspace.id, conversation.id),
    ).rejects.toMatchObject({
      status: 303,
      location: `/app/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}`,
    });
    expect(event.fetch.mock.calls).toHaveLength(2);
    for (const [, init] of event.fetch.mock.calls)
      expect(JSON.parse(String(init?.body))).toEqual({
        idempotencyKey: values.idempotencyKey,
        body: values.body,
      });
  });

  it('rejects whitespace as a forged group choice before any API request', async () => {
    const event = context();
    const request = new Request(event.url, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: new URLSearchParams({
        idempotencyKey: 'forged-choice',
        body: 'Find the right helper',
        groupGrantId: ' ',
      }),
    });
    expect(await submitTask({ ...event, request }, workspace.id, conversation.id)).toMatchObject({
      status: 400,
    });
    expect(event.fetch).not.toHaveBeenCalled();
  });

  it('preserves an uncertain retry command and confirms exactly that receipt without editing the Task prompt', async () => {
    const event = context();
    const values = { idempotencyKey: 'uncertain-retry', expectedRunId: task.runs[0]!.id };
    const queued = {
      ...task,
      runCount: 2,
      olderRunsCursor: 'older_attempt',
      runs: [{ ...task.runs[0], id: grant.id, attempt: 2 }],
    };
    event.fetch
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'task_unavailable' } }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({ task: queued, receipt: { runId: grant.id, attempt: 2 } }, { status: 202 }),
      );
    const request = () =>
      new Request(event.url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams(values),
      });
    expect(
      await retryTask({ ...event, request: request() }, workspace.id, conversation.id, task.id),
    ).toMatchObject({ status: 503, data: { values, uncertain: true, conflict: false } });
    await expect(
      retryTask({ ...event, request: request() }, workspace.id, conversation.id, task.id),
    ).rejects.toMatchObject({
      status: 303,
      location: `/app/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}`,
    });
    expect(event.fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of event.fetch.mock.calls) {
      expect(String(url)).toMatch(new RegExp(`/tasks/${task.id}/retries$`, 'u'));
      expect(init?.body).toBe(JSON.stringify(values));
    }
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'authentication_required', false],
    [403, 'task_forbidden', false],
    [409, 'task_retry_state_conflict', true],
    [409, 'task_retry_run_conflict', true],
    [409, 'idempotency_conflict', true],
  ] as const)(
    'handles retry HTTP %s/%s without disguising a lost session',
    async (status, code, conflict) => {
      const event = context(),
        values = { idempotencyKey: 'retained-key', expectedRunId: task.runs[0]!.id };
      event.fetch.mockResolvedValueOnce(Response.json({ error: { code } }, { status }));
      const pending = retryTask(
        {
          ...event,
          request: new Request(event.url, {
            method: 'POST',
            headers: { origin: 'http://localhost:3000' },
            body: new URLSearchParams(values),
          }),
        },
        workspace.id,
        conversation.id,
        task.id,
      );
      if (status === 401) {
        await expect(pending).rejects.toMatchObject({ status: 303, location: '/sign-in' });
        expect(event.cookies.delete).toHaveBeenCalled();
      } else {
        expect(await pending).toMatchObject({
          status,
          data: { values, conflict, uncertain: false },
        });
        expect(event.cookies.delete).not.toHaveBeenCalled();
      }
    },
  );

  it('reads older attempts using conversation access even when the retained Bot grant cannot execute', async () => {
    const event = context(),
      original = event.fetch.getMockImplementation()!;
    const saved = {
      ...task,
      groupGrantId: grant.id,
      runCount: 2,
      olderRunsCursor: 'older_attempt',
      runs: [{ ...task.runs[0], id: grant.id, attempt: 2 }],
    };
    const failed = {
      ...task.runs[0],
      status: 'failed',
      error: 'execution_forbidden',
      finishedAt: '2026-09-05T00:00:01.000Z',
    };
    event.fetch.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/tasks/${task.id}`)) return Response.json({ task: saved });
      if (path.endsWith(`/tasks/${task.id}/runs`))
        return Response.json({
          conversationId: conversation.id,
          taskId: task.id,
          runs: [failed],
          nextCursor: null,
        });
      if (path.includes('/bots') || path.includes('model-connections'))
        throw new Error('history_does_not_admit_provider');
      return original(url, init);
    });
    event.url.search = '?cursor=older_attempt&limit=5';
    expect(await loadTaskRunsPage(event, workspace.id, conversation.id, task.id)).toMatchObject({
      task: saved,
      runs: [failed],
      nextCursor: null,
      cursor: 'older_attempt',
      limit: 5,
    });
    expect(event.fetch.mock.calls).toHaveLength(6);
    expect(event.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
    expect(String(event.fetch.mock.calls.at(-1)?.[0])).toContain(
      '/runs?cursor=older_attempt&limit=5',
    );
  });
  it.each(['archived', 'deleted'] as const)(
    'keeps saved tasks readable while excluding a Bot with %s lifecycle from executable group choices',
    async (lifecycleState) => {
      const event = context();
      const original = event.fetch.getMockImplementation()!;
      event.fetch.mockImplementation(async (url, init) => {
        if (new URL(String(url)).pathname.endsWith(`/groups/${conversation.subject.id}/bots`))
          return Response.json({
            ...membership,
            canManage: false,
            grants: [
              {
                ...grant,
                conversationId: conversation.id,
                bot: { ...grant.bot, lifecycleState, canInspect: false },
              },
            ],
          });
        return original(url, init);
      });
      expect(await loadTasksPage(event, workspace.id, conversation.id)).toMatchObject({
        tasks: [{ ...task, groupGrantId: grant.id }],
        grants: [],
        canSubmit: false,
      });
      expect(event.cookies.delete).not.toHaveBeenCalled();
      expect(
        event.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
      ).toBe(true);
    },
  );

  it('reads a saved task without re-admitting its old grant or looking up a provider', async () => {
    const event = context();
    const original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith(`/tasks/${task.id}`))
        return Response.json({ task: { ...task, groupGrantId: grant.id } });
      if (String(url).includes('/bots') || String(url).includes('model-connections'))
        throw new Error('history_does_not_need_model_use');
      return original(url, init);
    });
    expect(await loadTaskPage(event, workspace.id, conversation.id, task.id)).toMatchObject({
      conversation,
      task: { ...task, groupGrantId: grant.id },
    });
    expect(event.fetch.mock.calls).toHaveLength(4);
    expect(event.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it.each([undefined, 'https://elsewhere.example', 'null'])(
    'rejects an untrusted Origin %s before any task request',
    async (origin) => {
      const event = context();
      const request = new Request(event.url, {
        method: 'POST',
        headers: origin === undefined ? {} : { origin },
        body: new URLSearchParams({ idempotencyKey: 'task-command', body: 'Keep this prompt.' }),
      });
      expect(await submitTask({ ...event, request }, workspace.id, conversation.id)).toMatchObject({
        status: 403,
      });
      expect(event.fetch).not.toHaveBeenCalled();
      expect(event.cookies.delete).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['actorUserId', user.id],
    ['body', 'different prompt'],
    ['connectionId', task.bot.id],
  ])('rejects forged or duplicate %s before calling the API', async (extra, value) => {
    const event = context();
    const fields = new URLSearchParams({
      idempotencyKey: 'task-command',
      body: 'Keep this prompt.',
    });
    fields.append(extra!, value!);
    const request = new Request(event.url, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: fields,
    });
    expect(await submitTask({ ...event, request }, workspace.id, conversation.id)).toMatchObject({
      status: 400,
    });
    expect(event.fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 409, 503])(
    'handles task write HTTP %s without leaking error diagnostics or misidentifying logout',
    async (status) => {
      const event = context();
      const code =
        status === 403
          ? 'task_forbidden'
          : status === 409
            ? 'idempotency_conflict'
            : 'authentication_required';
      event.fetch.mockResolvedValueOnce(
        Response.json(
          { error: { code, ...(status === 503 ? { message: 'secret diagnostics' } : {}) } },
          { status },
        ),
      );
      const values = { idempotencyKey: 'task-command', body: 'Keep this prompt.' };
      const request = new Request(event.url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams(values),
      });
      const pending = submitTask({ ...event, request }, workspace.id, conversation.id);
      if (status === 401) {
        await expect(pending).rejects.toMatchObject({ status: 303, location: '/sign-in' });
        expect(event.cookies.delete).toHaveBeenCalled();
      } else {
        const result = await pending;
        expect(result).toMatchObject({ status, data: { values, conflict: status === 409 } });
        expect(JSON.stringify(result)).not.toContain('secret diagnostics');
        expect(event.cookies.delete).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['cursor=one&cursor=two', 'limit=51', 'actorUserId=other', 'cursor=invalid%20cursor'])(
    'rejects malformed page query %s without API requests',
    async (query) => {
      const event = context();
      event.url.search = '?' + query;
      await expect(loadTasksPage(event, workspace.id, conversation.id)).rejects.toMatchObject({
        status: 400,
      });
      expect(event.fetch).not.toHaveBeenCalled();
    },
  );

  it('preserves the exact task command through an unknown outcome and redirects its unchanged retry to the saved task', async () => {
    const event = context();
    const values = {
      idempotencyKey: 'one-task-command',
      body: 'Compare\n  this evidence.',
      groupGrantId: grant.id,
    };
    const request = () =>
      new Request(event.url, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams(values),
      });
    event.fetch
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'task_unavailable' } }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({ task: { ...task, groupGrantId: grant.id } }, { status: 202 }),
      );
    expect(
      await submitTask({ ...event, request: request() }, workspace.id, conversation.id),
    ).toMatchObject({ status: 503, data: { values, uncertain: true, conflict: false } });
    await expect(
      submitTask({ ...event, request: request() }, workspace.id, conversation.id),
    ).rejects.toMatchObject({
      status: 303,
      location: `/app/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}`,
    });
    expect(event.fetch).toHaveBeenCalledTimes(2);
    expect(event.fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(values));
    expect(event.fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(values));
    expect(event.fetch.mock.calls.every(([url]) => String(url).endsWith('/tasks'))).toBe(true);
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });

  it('loads persistent group tasks and current grant choices without requiring direct Bot access', async () => {
    const event = context();
    const result = await loadTasksPage(event, workspace.id.toUpperCase(), conversation.id);
    expect(result).toMatchObject({
      user,
      workspace,
      conversation,
      canSubmit: true,
      grants: [{ id: grant.id, name: grant.bot.name }],
      tasks: [{ ...task, groupGrantId: grant.id }],
      nextCursor: 'next_task-page',
      cursor: 'task_cursor',
      limit: 5,
    });
    expect(result.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/u);
    expect(event.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
    expect(event.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
    expect(
      event.fetch.mock.calls.some(([url]) => /model-connections|\/bots\/[^/]+/u.test(String(url))),
    ).toBe(false);
    const paths = event.fetch.mock.calls.map(([url]) => new URL(String(url)));
    expect(paths.find((url) => url.pathname.endsWith('/tasks'))?.search).toBe(
      '?cursor=task_cursor&limit=5',
    );
    expect(
      paths.find((url) => url.pathname.endsWith(`/conversations/${conversation.id}`))?.search,
    ).toBe('?limit=1');
  });
});

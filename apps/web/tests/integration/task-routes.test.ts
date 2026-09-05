import { describe, expect, it, vi } from 'vitest';
import { loadTasksPage, loadTaskPage, submitTask } from '../../src/lib/server/task-page.js';
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

import { describe, expect, it, vi } from 'vitest';
import { loadConversationPage } from '../../src/lib/server/conversation-page.js';
import { loadTaskPage } from '../../src/lib/server/task-page.js';
import { task } from '../fixtures/tasks.js';
import { conversation, page, workspace, user, token } from '../fixtures/conversations.js';
import { decision, lead } from '../fixtures/routing.js';

const routed = {
  ...task,
  bot: { ...task.bot, id: lead.botId, versionId: lead.versionId, name: lead.name },
  groupGrantId: lead.grantId,
  routing: { algorithm: decision.algorithm, reason: decision.reason },
};
function context() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith(`/conversations/${conversation.id}`)) return Response.json(page);
    if (path.endsWith(`/tasks/${task.id}`)) return Response.json({ task: routed });
    if (path.endsWith(`/tasks/${task.id}/routing`)) return Response.json({ routing: decision });
    throw new Error('unexpected_request');
  });
  const url = new URL(
    `http://localhost:3000/app/workspaces/${workspace.id}/conversations/${conversation.id}?routingTaskId=${task.id.toUpperCase()}`,
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

describe('Selected Task routing evidence on actual pages', () => {
  it('loads just one scoped decision in the conversation without expanding the Task list', async () => {
    const event = context();
    const loaded = await loadConversationPage(event, workspace.id, conversation.id);
    expect(loaded).toMatchObject({ selectedRouting: { task: routed, decision } });
    expect(event.fetch.mock.calls).toHaveLength(5);
    expect(event.fetch.mock.calls.filter(([url]) => String(url).endsWith('/routing'))).toHaveLength(
      1,
    );
    const conversationRead = event.fetch.mock.calls.find(([url]) =>
      new URL(String(url)).pathname.endsWith(`/conversations/${conversation.id}`),
    );
    expect(new URL(String(conversationRead?.[0])).searchParams.has('routingTaskId')).toBe(false);
    expect(event.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it('shows the same saved decision on Task detail after its separately admitted Task read', async () => {
    const event = context();
    expect(await loadTaskPage(event, workspace.id, conversation.id, task.id)).toMatchObject({
      task: routed,
      routingDecision: decision,
    });
    expect(event.fetch.mock.calls).toHaveLength(5);
  });

  it('does not request Task evidence on an ordinary conversation load', async () => {
    const event = context();
    event.url.search = '';
    expect(await loadConversationPage(event, workspace.id, conversation.id)).not.toHaveProperty(
      'selectedRouting',
    );
    expect(event.fetch.mock.calls).toHaveLength(3);
  });

  it.each(['routingTaskId=bad', `routingTaskId=${task.id}&routingTaskId=${task.id}`])(
    'rejects an invalid selected Task query %s before reading its content',
    async (query) => {
      const event = context();
      event.url.search = query;
      await expect(
        loadConversationPage(event, workspace.id, conversation.id),
      ).rejects.toMatchObject({ status: 400 });
      expect(event.fetch.mock.calls.some(([url]) => String(url).includes('/tasks/'))).toBe(false);
    },
  );

  it.each(['conversation', 'task'] as const)(
    'fails closed when a valid decision identifies another pinned Bot version on the %s page',
    async (view) => {
      const event = context();
      const original = event.fetch.getMockImplementation()!;
      const changed = {
        ...decision,
        lead: { ...decision.lead, versionId: '11111111-1111-4111-8111-111111111111' },
        candidates: decision.candidates.map((candidate) =>
          candidate.grantId === lead.grantId
            ? { ...candidate, versionId: '11111111-1111-4111-8111-111111111111' }
            : candidate,
        ),
      };
      event.fetch.mockImplementation((url, init) =>
        String(url).endsWith('/routing')
          ? Promise.resolve(Response.json({ routing: changed }))
          : original(url, init),
      );
      await expect(
        view === 'task'
          ? loadTaskPage(event, workspace.id, conversation.id, task.id)
          : loadConversationPage(event, workspace.id, conversation.id),
      ).rejects.toMatchObject({ status: 503 });
      expect(event.cookies.delete).not.toHaveBeenCalled();
    },
  );

  it('rechecks current permission at the decision read and does not treat denial as logout', async () => {
    const event = context();
    const original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation((url, init) =>
      String(url).endsWith('/routing')
        ? Promise.resolve(Response.json({ error: { code: 'task_forbidden' } }, { status: 403 }))
        : original(url, init),
    );
    await expect(loadConversationPage(event, workspace.id, conversation.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });
});

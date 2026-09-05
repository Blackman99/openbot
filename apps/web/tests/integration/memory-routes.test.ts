import { describe, expect, it, vi } from 'vitest';
import {
  loadMemoriesPage,
  loadMemoryPage,
  saveMemoryAction,
  searchMemoryAction,
} from '../../src/lib/server/memory-page.js';
import {
  memory,
  command,
  conversation,
  message,
  workspace,
  user,
  group,
  membership,
  token,
} from '../fixtures/memories.js';
import { summary as botSummary } from '../fixtures/bots.js';
function context() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith(`/groups/${group.id}`)) return Response.json({ group });
    if (path.endsWith(`/groups/${group.id}/bots`)) return Response.json(membership);
    if (path.endsWith(`/workspaces/${workspace.id}/bots`))
      return Response.json({ bots: [botSummary] });
    if (path.endsWith(`/conversations/${conversation.id}`))
      return Response.json({ conversation, messages: [message], nextCursor: null, canWrite: true });
    if (path.endsWith(`/memories/${memory.id}`)) return Response.json({ memory });
    if (path.endsWith('/memories') && init?.method === 'POST')
      return Response.json({ memory }, { status: 201 });
    if (path.endsWith('/memories') || path.endsWith('/search'))
      return Response.json({ memories: [memory], nextAfter: null });
    throw new Error('Unexpected fixture path');
  });
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
    url: new URL(
      `http://localhost:3000/app/workspaces/${workspace.id}/groups/${group.id}/memories`,
    ),
  };
}
function request(form: Record<string, string>, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/action', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams(form),
  });
}
describe('Memory Web boundary', () => {
  it('loads current scoped memories and provenance privately', async () => {
    const event = context();
    expect(await loadMemoriesPage(event, workspace.id, group.id)).toMatchObject({
      group,
      memoryPage: { memories: [memory], nextAfter: null },
      grantId: '',
    });
    expect(event.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
    expect(await loadMemoryPage(event, workspace.id, group.id, memory.id)).toMatchObject({
      memory,
    });
  });
  it.each(['0.5', '5e-1'])(
    'saves a visible source using finite estimate %s, a stable key and exact event, then redirects to provenance',
    async (confidence) => {
      const event = context();
      await expect(
        saveMemoryAction(
          { ...event, request: request({ ...command, confidence, groupId: group.id }) },
          workspace.id,
          conversation.id,
        ),
      ).rejects.toMatchObject({
        status: 303,
        location: `/app/workspaces/${workspace.id}/groups/${group.id}/memories/${memory.id}`,
      });
      const call = event.fetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(String(call?.[1]?.body))).toEqual(command);
    },
  );
  it('submits private search text in a body with the selected exact group scope', async () => {
    const event = context();
    const result = await searchMemoryAction(
      { ...event, request: request({ query: 'private needle', grantId: '' }) },
      workspace.id,
      group.id,
    );
    expect(result).toMatchObject({
      action: 'search',
      values: { query: 'private needle', grantId: '' },
      memoryPage: { memories: [memory] },
    });
    const call = event.fetch.mock.calls.at(-1)!;
    expect(String(call[0])).not.toContain('private');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ query: 'private needle' });
  });
  it('loads the search action URL after a non-enhanced form without moving private search text into it', async () => {
    const event = context();
    event.url.search = '?/search';
    const result = await searchMemoryAction(
      { ...event, request: request({ query: 'private needle', grantId: '' }) },
      workspace.id,
      group.id,
    );
    expect(result).toMatchObject({ action: 'search', memoryPage: { memories: [memory] } });
    expect(await loadMemoriesPage(event, workspace.id, group.id)).toMatchObject({
      group,
      grantId: '',
    });
    expect(event.url.toString()).not.toContain('private');
  });
  it.each([
    '?/search=x',
    '?/search&/search',
    '?/saveMemory',
    '?query=private',
    '?grantId=&grantId=',
  ])('keeps rejecting invalid or duplicate memory page query %s', async (query) => {
    const event = context();
    event.url.search = query;
    await expect(loadMemoriesPage(event, workspace.id, group.id)).rejects.toMatchObject({
      status: 400,
    });
    expect(event.fetch).not.toHaveBeenCalled();
  });
  it('retains the original source precondition and key on a conflict', async () => {
    const event = context();
    const original = event.fetch.getMockImplementation()!;
    event.fetch.mockImplementation(async (url, init) =>
      init?.method === 'POST'
        ? Response.json({ error: { code: 'source_version_conflict' } }, { status: 409 })
        : original(url, init),
    );
    const result = await saveMemoryAction(
      { ...event, request: request({ ...command, groupId: group.id, confidence: '0.5' }) },
      workspace.id,
      conversation.id,
    );
    expect(result).toMatchObject({
      status: 409,
      data: {
        action: 'saveMemory',
        conflict: true,
        values: {
          messageId: message.id,
          expectedSourceEventId: message.versionEventId,
          idempotencyKey: command.idempotencyKey,
        },
      },
    });
  });
  it.each([
    { kind: 'group', id: '20000000-0000-4000-8000-000000000002' },
    { kind: 'direct-bot', id: group.id },
  ])(
    'rejects a save posted through a $kind conversation outside the form group before creating it',
    async (subject) => {
      const event = context();
      const original = event.fetch.getMockImplementation()!;
      event.fetch.mockImplementation(async (url, init) =>
        String(url).includes(`/conversations/${conversation.id}`)
          ? Response.json({
              conversation: {
                ...conversation,
                subject,
                ...(subject.kind === 'direct-bot' ? { botLifecycleState: 'active' } : {}),
              },
              messages: [message],
              nextCursor: null,
              canWrite: true,
            })
          : original(url, init),
      );
      expect(
        await saveMemoryAction(
          { ...event, request: request({ ...command, groupId: group.id, confidence: '0.5' }) },
          workspace.id,
          conversation.id,
        ),
      ).toMatchObject({ status: 403 });
      expect(event.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    },
  );
  it('refuses foreign origins, forged confidence and search text in the URL before sending data', async () => {
    const event = context();
    expect(
      await saveMemoryAction(
        {
          ...event,
          request: request(
            { ...command, groupId: group.id, confidence: '0.5' },
            'https://other.example',
          ),
        },
        workspace.id,
        conversation.id,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await saveMemoryAction(
        { ...event, request: request({ ...command, groupId: group.id, confidence: 'Infinity' }) },
        workspace.id,
        conversation.id,
      ),
    ).toMatchObject({ status: 400 });
    expect(event.fetch).not.toHaveBeenCalled();
    event.url.searchParams.set('query', 'do-not-log');
    await expect(loadMemoriesPage(event, workspace.id, group.id)).rejects.toMatchObject({
      status: 400,
    });
  });
});

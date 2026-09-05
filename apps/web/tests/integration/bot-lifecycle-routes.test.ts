import { describe, expect, it, vi } from 'vitest';
import {
  botLifecycleAction,
  loadBotLifecyclePage,
  loadDeletedBotsPage,
} from '../../src/lib/server/bot-lifecycle-page.js';
import { bot, summary, token, user, workspace } from '../fixtures/bots.js';
const lifecycle = {
  botId: bot.id,
  workspaceId: workspace.id,
  state: 'deleted',
  deletedAt: '2030-01-01T00:00:00.000Z',
  recoveryDeadline: '2030-01-31T00:00:00.000Z',
  preDeletedState: 'active',
};
function context(accessRole: 'owner' | 'editor' | 'user' = 'owner') {
  return {
    fetch: vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/me')) return Response.json({ user, workspace: null });
      if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
      if (path.endsWith(`/bots/${bot.id}`))
        return Response.json({ bot: { ...bot, accessRole, lifecycleState: 'deleted' } });
      if (path.endsWith('/lifecycle')) return Response.json({ lifecycle });
      if (String(url).endsWith('/bots?view=deleted'))
        return Response.json({ bots: [{ ...summary, lifecycleState: 'deleted' }] });
      throw new Error('Unexpected request');
    }),
    cookies: {
      get: vi.fn(() => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
    setHeaders: vi.fn(),
  };
}
const request = () =>
  new Request('http://localhost:3000/lifecycle', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
    body: new URLSearchParams(),
  });
describe('owner lifecycle pages and actions', () => {
  it('bounds an unfinished form body and does not send a mutation after the body deadline', async () => {
    vi.useFakeTimers();
    try {
      const event = context();
      const input = new Request('http://localhost:3000/lifecycle', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new ReadableStream(),
        ...{ duplex: 'half' },
      });
      const result = botLifecycleAction(
        { ...event, request: input },
        workspace.id,
        bot.id,
        'archive',
      );
      await vi.advanceTimersByTimeAsync(30001);
      expect(await result).toMatchObject({ status: 400 });
      expect(event.fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('loads reachable owner recovery and persisted deadline without exposing configuration', async () => {
    const event = context();
    const result = await loadBotLifecyclePage(event, workspace.id, bot.id);
    expect(result).toMatchObject({ bot: { id: bot.id, name: bot.name }, lifecycle });
    expect(JSON.stringify(result)).not.toContain('instructions');
    expect((await loadDeletedBotsPage(event, workspace.id)).bots).toMatchObject([
      { id: bot.id, lifecycleState: 'deleted' },
    ]);
    expect(event.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it.each(['editor', 'user'] as const)(
    'rejects %s lifecycle UI before fetching recovery details',
    async (role) => {
      const event = context(role);
      await expect(loadBotLifecyclePage(event, workspace.id, bot.id)).rejects.toMatchObject({
        status: 403,
      });
      expect(event.fetch.mock.calls.some(([url]) => String(url).endsWith('/lifecycle'))).toBe(
        false,
      );
    },
  );
  it('uses current API authorization for mutations and returns a confirmed state', async () => {
    const event = context();
    event.fetch.mockResolvedValueOnce(Response.json({ lifecycle }));
    expect(
      await botLifecycleAction({ ...event, request: request() }, workspace.id, bot.id, 'delete'),
    ).toMatchObject({
      message: 'Bot deleted. Recovery remains available until the recorded deadline.',
    });
    expect(event.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [403, 'bot_forbidden', 403],
    [409, 'bot_recovery_expired', 409],
    [409, 'bot_lifecycle_conflict', 409],
    [503, 'bot_unavailable', 503],
  ] as const)('reports %s/%s safely and preserves session', async (status, code, expected) => {
    const event = context();
    event.fetch.mockResolvedValueOnce(Response.json({ error: { code } }, { status }));
    const result = await botLifecycleAction(
      { ...event, request: request() },
      workspace.id,
      bot.id,
      'undo-delete',
    );
    expect(result).toMatchObject({ status: expected });
    if (status === 503)
      expect(result).toMatchObject({
        data: { uncertain: true, error: expect.stringContaining('could not be confirmed') },
      });
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });
  it('rejects cross-Origin, unexpected fields and an oversized streaming form without API writes', async () => {
    for (const input of [
      new Request('http://localhost:3000/lifecycle', { method: 'POST', body: '' }),
      new Request('http://localhost:3000/lifecycle', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ state: 'active' }),
      }),
      new Request('http://localhost:3000/lifecycle', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: 'x'.repeat(1025),
      }),
    ]) {
      const event = context();
      expect(
        await botLifecycleAction({ ...event, request: input }, workspace.id, bot.id, 'archive'),
      ).toMatchObject({ status: expect.any(Number) });
      expect(event.fetch).not.toHaveBeenCalled();
    }
  });
});

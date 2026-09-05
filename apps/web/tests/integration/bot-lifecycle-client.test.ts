import { describe, expect, it, vi } from 'vitest';
import { BotLifecycleApiClient } from '../../src/lib/server/bot-lifecycle-api.js';
import { bot, token, workspace } from '../fixtures/bots.js';
const active = {
  botId: bot.id,
  workspaceId: workspace.id,
  state: 'active',
  deletedAt: null,
  recoveryDeadline: null,
  preDeletedState: null,
};
const deleted = {
  ...active,
  state: 'deleted',
  deletedAt: '2030-01-01T00:00:00.000Z',
  recoveryDeadline: '2030-01-31T00:00:00.000Z',
  preDeletedState: 'active',
};
function client(payload: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
  return {
    request,
    api: new BotLifecycleApiClient(request, 'http://api:3001', 'http://localhost:3000'),
  };
}
describe('strict Bot lifecycle transport', () => {
  it('sends scoped bodyless commands with Origin and keeps the immutable recovery window', async () => {
    const { api, request } = client({ lifecycle: deleted });
    expect(await api.change(token, workspace.id, bot.id, 'delete')).toEqual({
      status: 'available',
      value: deleted,
    });
    expect(request.mock.calls[0]).toMatchObject([
      `http://api:3001/api/v1/workspaces/${workspace.id}/bots/${bot.id}/delete`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { origin: 'http://localhost:3000', cookie: `openbot_session=${token}` },
      },
    ]);
  });
  it.each([
    { ...deleted, botId: workspace.id },
    { ...deleted, workspaceId: bot.id },
    { ...deleted, recoveryDeadline: deleted.deletedAt },
    { ...active, deletedAt: deleted.deletedAt },
    { ...deleted, preDeletedState: 'deleted' },
    { ...active, state: 'erased' },
    { ...active, credentials: 'secret' },
  ])('rejects mismatched or impossible lifecycle responses', async (value) => {
    expect(await client({ lifecycle: value }).api.get(token, workspace.id, bot.id)).toEqual({
      status: 'unavailable',
    });
  });
  it.each([
    [403, 'bot_forbidden', 'forbidden'],
    [400, 'invalid_bot_request', 'invalid'],
    [409, 'bot_lifecycle_conflict', 'conflict'],
    [409, 'bot_recovery_expired', 'expired'],
    [500, 'bot_recovery_expired', 'unavailable'],
  ])('matches safe errors to HTTP status', async (status, code, expected) => {
    expect(
      await client({ error: { code } }, Number(status)).api.change(
        token,
        workspace.id,
        bot.id,
        'archive',
      ),
    ).toEqual({ status: expected });
  });
  it('retains current model rejection and does not accept the wrong transition target', async () => {
    expect(
      await client(
        { error: { code: 'bot_model_unavailable', reason: 'disabled' } },
        400,
      ).api.change(token, workspace.id, bot.id, 'restore'),
    ).toEqual({ status: 'model-unavailable', reason: 'disabled' });
    expect(
      await client({ lifecycle: active }).api.change(token, workspace.id, bot.id, 'delete'),
    ).toEqual({ status: 'unavailable' });
  });
  it('aborts an oversized response and a stalled response body within the fixed deadline', async () => {
    expect(
      await client({ lifecycle: active, extra: 'x'.repeat(17000) }).api.get(
        token,
        workspace.id,
        bot.id,
      ),
    ).toEqual({ status: 'unavailable' });
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>(
        async () => new Response(new ReadableStream({ start() {} })),
      );
      const result = new BotLifecycleApiClient(
        request,
        'http://api:3001',
        'http://localhost:3000',
      ).get(token, workspace.id, bot.id);
      await vi.advanceTimersByTimeAsync(30001);
      expect(await result).toEqual({ status: 'unavailable' });
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

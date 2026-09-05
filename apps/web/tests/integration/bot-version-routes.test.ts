import { describe, expect, it, vi } from 'vitest';
import {
  botVersionAction,
  loadBotEditPage,
  loadBotVersionPage,
  loadVersionHistoryPage,
  loadVersionComparisonPage,
} from '../../src/lib/server/bot-version-page.js';
import { bot, input, summary, token, user, workspace } from '../fixtures/bots.js';
const { configuration: _configuration, ...metadata } = bot.currentVersion;
const origin = 'http://localhost:3000';
const route = `/app/workspaces/${workspace.id}/bots/${bot.id}`;
function context(detail: unknown = bot) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith(`/bots/${bot.id}`)) return Response.json({ bot: detail });
    if (path.endsWith('/versions/compare'))
      return Response.json({
        fromVersionId: bot.currentVersion.id,
        toVersionId: bot.currentVersion.id,
        differences: [],
      });
    if (path.endsWith('/versions'))
      return Response.json({
        currentVersionId: bot.currentVersion.id,
        versions: [metadata],
        nextBefore: null,
      });
    if (path.endsWith(`/versions/${bot.currentVersion.id}`))
      return Response.json({ version: bot.currentVersion });
    if (path === '/api/v1/model-connections') return Response.json([]);
    if (path.endsWith('/model-connections'))
      return Response.json({ canManage: false, connections: [] });
    throw new Error(`Unexpected ${path}`);
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
    url: new URL(`${origin}${route}/versions`),
  };
}
function request(values: Record<string, string>, requestOrigin = origin) {
  return new Request(`${origin}${route}/edit`, {
    method: 'POST',
    headers: { origin: requestOrigin },
    body: new URLSearchParams(values),
  });
}
describe('Bot version page boundaries', () => {
  it('never interprets an omitted disabled model selection as an intentional Keep current model', async () => {
    const event = context();
    event.fetch.mockResolvedValueOnce(Response.json({ version: bot.currentVersion }));
    expect(
      await botVersionAction(
        {
          ...event,
          request: request({ expectedCurrentVersionId: bot.currentVersion.id, name: bot.name }),
        },
        workspace.id,
        bot.id,
        'edit',
      ),
    ).toMatchObject({ status: 400 });
    expect(event.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])(
    'clears the browser cookie only for a real HTTP401, not status %s',
    async (status) => {
      const event = context();
      event.fetch.mockResolvedValueOnce(
        Response.json(
          { error: { code: status === 403 ? 'bot_forbidden' : 'authentication_required' } },
          { status },
        ),
      );
      const result = botVersionAction(
        {
          ...event,
          request: request({
            expectedCurrentVersionId: bot.currentVersion.id,
            modelChoice: 'keep',
            name: bot.name,
          }),
        },
        workspace.id,
        bot.id,
        'edit',
      );
      if (status === 401) {
        await expect(result).rejects.toMatchObject({ status: 303, location: '/sign-in' });
        expect(event.cookies.delete).toHaveBeenCalled();
      } else {
        expect(await result).toMatchObject({ status: status === 403 ? 403 : 503 });
        expect(event.cookies.delete).not.toHaveBeenCalled();
      }
    },
  );
  it('rejects history pagination and edit access that current identity does not permit', async () => {
    const event = context({ ...bot, accessRole: 'user' });
    await expect(loadBotEditPage(event, workspace.id, bot.id)).rejects.toMatchObject({
      status: 403,
    });
    for (const query of ['?before=1&before=2', '?limit=101', '?limit=1&author=forged']) {
      const ctx = context();
      ctx.url.search = query;
      await expect(loadVersionHistoryPage(ctx, workspace.id, bot.id)).rejects.toMatchObject({
        status: 400,
      });
    }
  });
  it('loads current editor context with safe model choices while retaining unavailable current bindings', async () => {
    const event = context({ ...bot, bindingStatus: { state: 'unavailable', reason: 'disabled' } });
    expect(await loadBotEditPage(event, workspace.id, bot.id)).toMatchObject({
      bot: { currentVersion: bot.currentVersion },
      canEdit: true,
      models: [],
    });
    expect(event.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });
  it('loads paged metadata and separately authorized history without exposing history to discovery viewers', async () => {
    const event = context();
    event.url.search = '?before=2&limit=1';
    expect(await loadVersionHistoryPage(event, workspace.id, bot.id)).toMatchObject({
      history: { versions: [metadata] },
      limit: 1,
      before: 2,
    });
    expect(event.fetch.mock.calls.at(-1)?.[0]).toContain('/versions?before=2&limit=1');
    expect(
      await loadBotVersionPage(context(), workspace.id, bot.id, bot.currentVersion.id),
    ).toMatchObject({ version: bot.currentVersion });
    const discovery = context({ ...summary, visibility: 'workspace', accessRole: null });
    await expect(loadVersionHistoryPage(discovery, workspace.id, bot.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(discovery.fetch.mock.calls.some(([url]) => String(url).includes('/versions'))).toBe(
      false,
    );
    expect(discovery.cookies.delete).not.toHaveBeenCalled();
  });
  it('opens scalar comparisons through explicit version query IDs', async () => {
    const event = context();
    event.url.search = new URLSearchParams({
      fromVersionId: bot.currentVersion.id,
      toVersionId: bot.currentVersion.id,
    }).toString();
    expect(await loadVersionComparisonPage(event, workspace.id, bot.id)).toMatchObject({
      comparison: { differences: [] },
      fromVersion: { number: 1 },
      toVersion: { number: 1 },
    });
  });
  it('sends only an explicit edit patch and keeps the old precondition and full draft on conflict', async () => {
    const event = context();
    event.fetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'bot_version_conflict' } }, { status: 409 }),
    );
    const values = {
      expectedCurrentVersionId: bot.currentVersion.id,
      name: 'Draft name',
      instructions: '\n  Draft instructions\n',
      modelChoice: 'keep',
      maxTurns: '3',
      rationale: 'Why',
    };
    expect(
      await botVersionAction({ ...event, request: request(values) }, workspace.id, bot.id, 'edit'),
    ).toMatchObject({
      status: 409,
      data: { values, blocked: true, error: expect.stringContaining('Reload') },
    });
    const body = JSON.parse(String(event.fetch.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      expectedCurrentVersionId: bot.currentVersion.id,
      changes: { name: values.name, instructions: values.instructions, limits: { maxTurns: 3 } },
      rationale: 'Why',
    });
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });
  it('preserves an unknown restore result and directs inspection instead of promising rollback or retrying', async () => {
    const event = context();
    event.fetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'bot_version_unavailable' } }, { status: 503 }),
    );
    const values = {
      expectedCurrentVersionId: bot.currentVersion.id,
      sourceVersionId: bot.currentVersion.id,
      rationale: 'Restore my version',
    };
    const result = await botVersionAction(
      { ...event, request: request(values) },
      workspace.id,
      bot.id,
      'restore',
    );
    expect(result).toMatchObject({
      status: 503,
      data: { values, blocked: true, error: expect.stringContaining('Reload') },
    });
    expect(JSON.stringify(result)).not.toMatch(/rolled back|nothing changed|try again/iu);
  });
  it('rejects untrusted browser Origin and storage object injection before internal requests', async () => {
    const event = context();
    const values = { expectedCurrentVersionId: bot.currentVersion.id, name: input.name };
    expect(
      await botVersionAction(
        { ...event, request: request(values, 'https://evil.example') },
        workspace.id,
        bot.id,
        'edit',
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await botVersionAction(
        { ...event, request: request({ ...values, avatarObjectId: bot.id }) },
        workspace.id,
        bot.id,
        'edit',
      ),
    ).toMatchObject({ status: 400 });
    expect(event.fetch).not.toHaveBeenCalled();
  });
});

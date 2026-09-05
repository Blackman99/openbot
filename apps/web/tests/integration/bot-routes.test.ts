import { describe, expect, it, vi } from 'vitest';
import { createBotAction, loadBotPage, loadBotsPage } from '../../src/lib/server/bot-page.js';
import { bot, input, summary, token, user, workspace } from '../fixtures/bots.js';
import { catalog } from '../fixtures/capability.js';
const personalId = 'fe661304-a1bc-4767-9a87-c47de763f749';
const report = {
  testedAt: catalog.lastProbedAt,
  text: { ok: true, code: 'passed', raw: 'private-evidence' },
  action: { ok: false, code: 'failed', raw: 'private-evidence' },
};
const personal = {
  id: personalId,
  name: 'Personal Basic',
  protocol: 'openai-chat',
  modelId: 'personal-model',
  baseUrl: 'https://secret-endpoint.invalid',
  enabled: true,
  apiKeyConfigured: true,
  headerNames: ['private-header'],
  lastProbe: report,
};
function cookies() {
  return {
    get: vi.fn(() => token),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}
function context(detail: unknown = bot) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith('/bots'))
      return init?.method === 'POST'
        ? Response.json({ bot }, { status: 201 })
        : Response.json({ bots: [summary] });
    if (path.endsWith(`/bots/${bot.id}`)) return Response.json({ bot: detail });
    if (path === '/api/v1/model-connections') return Response.json([personal]);
    if (path.endsWith('/model-connections'))
      return Response.json({
        canManage: false,
        connections: [
          {
            id: input.modelBinding.connectionId,
            name: 'Team Basic',
            protocol: 'openai-chat',
            modelId: input.modelBinding.modelId,
            availability: 'available',
            lastProbe: {
              testedAt: report.testedAt,
              text: { ok: true, code: 'passed' },
              action: { ok: false, code: 'failed' },
            },
          },
        ],
      });
    if (path.endsWith('/policy')) {
      const shared = path.includes('/workspaces/');
      return Response.json({
        ...catalog,
        id: shared ? input.modelBinding.connectionId : personalId,
        name: shared ? 'Team Basic' : 'Personal Basic',
        modelId: shared ? input.modelBinding.modelId : 'personal-model',
      });
    }
    throw new Error(`Unexpected ${path}`);
  });
  return { fetch, cookies: cookies(), setHeaders: vi.fn() };
}
function form(values: Record<string, string> = {}) {
  return new Request('http://localhost:3000/bots', {
    method: 'POST',
    body: new URLSearchParams({
      name: input.name,
      roleDescription: input.roleDescription,
      description: input.description,
      instructions: input.instructions,
      modelChoice: JSON.stringify(input.modelBinding),
      ...values,
    }),
  });
}
describe('Bot page boundaries', () => {
  it('loads scoped Bots and only safe personal/workspace capability choices without probing', async () => {
    const ctx = context();
    const result = await loadBotsPage(ctx, workspace.id.toUpperCase());
    expect(result).toMatchObject({ user, workspace, bots: [summary], modelsUnavailable: false });
    expect(result.models).toEqual([
      {
        scope: { kind: 'personal', id: user.id },
        connectionId: personalId,
        modelId: 'personal-model',
        name: 'Personal Basic',
        enabled: true,
        basic: true,
        collaboration: false,
        available: true,
      },
      {
        ...input.modelBinding,
        name: 'Team Basic',
        enabled: true,
        basic: true,
        collaboration: false,
        available: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /private-evidence|secret-endpoint|private-header|fallbacks|apiKey/,
    );
    expect(ctx.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
    expect(ctx.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });
  it('returns discovery metadata without fetching model connections or instructions', async () => {
    const discovery = { ...summary, accessRole: null, visibility: 'workspace' };
    const ctx = context(discovery);
    expect(await loadBotPage(ctx, workspace.id, bot.id)).toMatchObject({ bot: discovery });
    expect(ctx.fetch.mock.calls).toHaveLength(3);
  });
  it('creates with persisted defaults, unmodified instructions and server-derived scope, ignoring forged authority', async () => {
    const ctx = context();
    ctx.setHeaders.mockImplementation(() => {
      if (ctx.setHeaders.mock.calls.length > 1) throw new Error('Headers already set');
    });
    await expect(
      createBotAction(
        {
          ...ctx,
          request: form({ actorUserId: 'forged', accessRole: 'owner', visibility: 'workspace' }),
        },
        workspace.id,
      ),
    ).rejects.toMatchObject({
      status: 303,
      location: `/app/workspaces/${workspace.id}/bots/${bot.id}`,
    });
    const call = ctx.fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(input);
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([
    { name: ' '.repeat(10) },
    { name: 'x'.repeat(101) },
    { roleDescription: 'x'.repeat(201) },
    { description: 'x'.repeat(2001) },
    { instructions: 'x'.repeat(32001) },
    { instructions: '  ' },
    { maxTotalTokens: '0' },
    { maxDurationSeconds: '3601' },
    { maxTurns: '1.5' },
    { maxDelegationDepth: '9' },
    { modelChoice: '{}' },
  ])('rejects invalid creation fields before contacting the API: %j', async (values) => {
    const ctx = context();
    expect(await createBotAction({ ...ctx, request: form(values) }, workspace.id)).toMatchObject({
      status: 400,
    });
    expect(ctx.fetch).not.toHaveBeenCalled();
  });
  it('rejects forged personal scope and allows zero delegation depth', async () => {
    const invalid = context();
    expect(
      await createBotAction(
        {
          ...invalid,
          request: form({
            modelChoice: JSON.stringify({
              ...input.modelBinding,
              scope: { kind: 'personal', id: bot.id },
            }),
          }),
        },
        workspace.id,
      ),
    ).toMatchObject({ status: 400 });
    expect(invalid.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    const valid = context();
    await expect(
      createBotAction({ ...valid, request: form({ maxDelegationDepth: '0' }) }, workspace.id),
    ).rejects.toMatchObject({ status: 303 });
    expect(
      JSON.parse(
        String(valid.fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body),
      ).limits.maxDelegationDepth,
    ).toBe(0);
  });
  it.each([
    ['disabled', 'disabled'],
    ['binding-changed', 'different model'],
    ['capability-unavailable', 'text and streaming'],
    ['not-accessible', 'cannot use'],
  ])(
    'preserves entered instructions and explains current model rejection %s',
    async (reason, message) => {
      const ctx = context();
      const base = ctx.fetch.getMockImplementation()!;
      ctx.fetch.mockImplementation(async (url, init) =>
        init?.method === 'POST'
          ? Response.json({ error: { code: 'bot_model_unavailable', reason } }, { status: 400 })
          : base(url, init),
      );
      expect(await createBotAction({ ...ctx, request: form() }, workspace.id)).toMatchObject({
        status: 400,
        data: {
          error: expect.stringContaining(message),
          values: { instructions: input.instructions },
        },
      });
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    },
  );
  it('keeps a valid identity when workspace/Bot access is revoked and masks upstream failures', async () => {
    const ctx = context();
    const base = ctx.fetch.getMockImplementation()!;
    ctx.fetch.mockImplementation(async (url, init) =>
      String(url).includes('/bots')
        ? Response.json({ error: { code: 'bot_forbidden' } }, { status: 403 })
        : base(url, init),
    );
    await expect(loadBotPage(ctx, workspace.id, bot.id)).rejects.toMatchObject({ status: 403 });
    expect(await createBotAction({ ...ctx, request: form() }, workspace.id)).toMatchObject({
      status: 403,
    });
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
    ctx.fetch.mockImplementation(async (url, init) =>
      String(url).includes('/bots')
        ? Response.json(
            { error: { code: 'authentication_required', detail: 'secret' } },
            { status: 500 },
          )
        : base(url, init),
    );
    await expect(loadBotsPage(ctx, workspace.id)).rejects.toMatchObject({
      status: 503,
      body: { message: 'Bot service unavailable' },
    });
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  });
  it('tracks real HTTP 401s from reused provider clients without trusting error text on 500', async () => {
    for (const status of [500, 401]) {
      const ctx = context();
      const base = ctx.fetch.getMockImplementation()!;
      ctx.fetch.mockImplementation(async (url, init) =>
        new URL(String(url)).pathname === '/api/v1/model-connections'
          ? Response.json({ error: { code: 'authentication_required' } }, { status })
          : base(url, init),
      );
      if (status === 401) {
        await expect(loadBotsPage(ctx, workspace.id)).rejects.toMatchObject({
          status: 303,
          location: '/sign-in',
        });
        expect(ctx.cookies.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
      } else {
        expect(await loadBotsPage(ctx, workspace.id)).toMatchObject({ modelsUnavailable: true });
        expect(ctx.cookies.delete).not.toHaveBeenCalled();
      }
    }
  });
  it('disables changed or unverified capability choices while keeping other models usable', async () => {
    const ctx = context();
    const base = ctx.fetch.getMockImplementation()!;
    ctx.fetch.mockImplementation(async (url, init) =>
      String(url).endsWith(`${personalId}/policy`)
        ? Response.json({ ...catalog, id: personalId, modelId: 'changed-model' })
        : base(url, init),
    );
    const page = await loadBotsPage(ctx, workspace.id);
    expect(page.models[0]).toMatchObject({
      modelId: 'personal-model',
      available: false,
      basic: false,
      collaboration: false,
    });
    expect(page.models[1]).toMatchObject({ available: true, basic: true });
  });
});

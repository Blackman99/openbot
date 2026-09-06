import { expect, it, vi } from 'vitest';
import {
  botImportAction,
  downloadBotTemplate,
  loadBotImportPage,
} from '../../src/lib/server/bot-template-page.js';
import { bot, summary, token, user, workspace } from '../fixtures/bots.js';
import { catalog } from '../fixtures/capability.js';
import { imported, model, preview, template } from '../fixtures/bot-template.js';

const origin = 'http://localhost:3000';
const personalId = 'fe661304-a1bc-4767-9c72-fb4e9d01766c';

function cookies() {
  return {
    get: vi.fn(() => token),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}

function context() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/me')) return Response.json({ user, workspace: null });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith('/bots')) return Response.json({ bots: [summary] });
    if (path.endsWith(`/bots/${bot.id}/template`)) return Response.json({ template });
    if (path.endsWith('/bot-templates/previews')) return Response.json({ preview });
    if (path.endsWith('/bot-templates') && init?.method === 'POST')
      return Response.json({ bot: imported }, { status: 201 });
    if (path === '/api/v1/model-connections')
      return Response.json([
        {
          id: personalId,
          name: 'Personal Basic',
          protocol: 'openai-chat',
          modelId: 'personal-model',
          baseUrl: 'https://secret-endpoint.invalid',
          enabled: true,
          apiKeyConfigured: true,
          headerNames: [],
          lastProbe: {
            testedAt: catalog.lastProbedAt,
            text: { ok: true, code: 'passed', raw: 'private-evidence' },
            action: { ok: false, code: 'failed', raw: 'private-evidence' },
          },
        },
      ]);
    if (path.endsWith('/model-connections'))
      return Response.json({
        canManage: false,
        connections: [
          {
            id: model.connectionId,
            name: model.name,
            protocol: 'openai-chat',
            modelId: model.modelId,
            availability: 'available',
            lastProbe: {
              testedAt: catalog.lastProbedAt,
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
        id: shared ? model.connectionId : personalId,
        name: shared ? model.name : 'Personal Basic',
        modelId: shared ? model.modelId : 'personal-model',
      });
    }
    throw new Error(`Unexpected ${path}`);
  });
  return { fetch, cookies: cookies(), setHeaders: vi.fn() };
}

function request(values: Record<string, string>, requestOrigin = origin) {
  return new Request(`${origin}/import`, {
    method: 'POST',
    headers: { origin: requestOrigin },
    body: new URLSearchParams(values),
  });
}

it('loads import choices without writing and previews the reviewed template', async () => {
  const event = context();
  const page = await loadBotImportPage(event, workspace.id);
  expect(page.bots).toEqual([summary]);
  expect(page.models.some((item) => item.connectionId === model.connectionId && item.basic)).toBe(
    true,
  );
  expect(
    event.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
  ).toBe(true);
  const previewResult = await botImportAction(
    {
      ...event,
      request: request({
        intent: 'preview',
        template: JSON.stringify(template),
        compareBotId: bot.id,
      }),
    },
    workspace.id,
  );
  expect(previewResult).toMatchObject({ preview });
});

it('creates only after an explicit compatible binding and redirects to the new Bot', async () => {
  const event = context();
  const binding = {
    scope: model.scope,
    connectionId: model.connectionId,
    modelId: model.modelId,
  };
  await expect(
    botImportAction(
      {
        ...event,
        request: request({
          intent: 'create',
          template: JSON.stringify(template),
          modelChoice: JSON.stringify(binding),
        }),
      },
      workspace.id,
    ),
  ).rejects.toMatchObject({
    status: 303,
    location: `/app/workspaces/${workspace.id}/bots/${imported.id}`,
  });
  expect(JSON.parse(String(event.fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
    template,
    modelBinding: binding,
  });
});

it('rejects malformed templates, missing bindings and foreign origins before create', async () => {
  const event = context();
  expect(
    await botImportAction(
      { ...event, request: request({ intent: 'preview', template: '{not-json' }) },
      workspace.id,
    ),
  ).toMatchObject({ status: 400 });
  expect(
    await botImportAction(
      {
        ...event,
        request: request({ intent: 'create', template: JSON.stringify(template) }),
      },
      workspace.id,
    ),
  ).toMatchObject({ status: 400, data: { error: expect.stringMatching(/Bind a compatible/) } });
  expect(
    await botImportAction(
      {
        ...event,
        request: request(
          { intent: 'preview', template: JSON.stringify(template) },
          'http://evil.example',
        ),
      },
      workspace.id,
    ),
  ).toMatchObject({ status: 403 });
  expect(
    event.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
  ).toBe(true);
});

it('downloads the reviewed export without secrets or source identifiers', async () => {
  const event = context();
  const response = await downloadBotTemplate(event, workspace.id, bot.id);
  expect(response.headers.get('content-disposition')).toContain('bot-template.json');
  const body = await response.text();
  expect(JSON.parse(body).template).toEqual(template);
  expect(body).not.toContain('apiKey');
  expect(body).not.toContain('connectionId');
});

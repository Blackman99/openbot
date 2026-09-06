import { expect, it, vi } from 'vitest';
import {
  downloadTeamTemplate,
  loadTeamImportPage,
  teamImportAction,
} from '../../src/lib/server/team-template-page.js';
import { bot, summary, token, user, workspace } from '../fixtures/bots.js';
import { catalog } from '../fixtures/capability.js';
import { model } from '../fixtures/bot-template.js';
import { importedTeam, teamPreview, teamTemplate } from '../fixtures/team-template.js';

const origin = 'http://localhost:3000';

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
    if (path.endsWith(`/groups/${importedTeam.id}/template`))
      return Response.json({ template: teamTemplate });
    if (path.endsWith('/team-templates/previews')) return Response.json({ preview: teamPreview });
    if (path.endsWith('/team-templates') && init?.method === 'POST')
      return Response.json({ group: importedTeam, bots: [] }, { status: 201 });
    if (path === '/api/v1/model-connections')
      return Response.json([
        {
          id: 'fe661304-a1bc-4767-9c72-fb4e9d01766c',
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
      return Response.json({
        ...catalog,
        id: model.connectionId,
        name: model.name,
        modelId: model.modelId,
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

it('loads import choices without writing and previews every object to create', async () => {
  const event = context();
  const page = await loadTeamImportPage(event, workspace.id);
  expect(page.bots).toEqual([summary]);
  expect(
    event.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
  ).toBe(true);
  const previewResult = await teamImportAction(
    {
      ...event,
      request: request({
        intent: 'preview',
        template: JSON.stringify(teamTemplate),
      }),
    },
    workspace.id,
  );
  expect(previewResult).toMatchObject({ preview: teamPreview });
});

it('creates only after mappings and acknowledgements and redirects to the new group', async () => {
  const event = context();
  const binding = {
    scope: model.scope,
    connectionId: model.connectionId,
    modelId: model.modelId,
  };
  await expect(
    teamImportAction(
      {
        ...event,
        request: request({
          intent: 'create',
          template: JSON.stringify(teamTemplate),
          'modelBinding.researcher': JSON.stringify(binding),
          'ack.create-bots': 'on',
          'ack.create-memberships': 'on',
          'ack.create-group-configuration': 'on',
          'ack.no-source-access': 'on',
        }),
      },
      workspace.id,
    ),
  ).rejects.toMatchObject({
    status: 303,
    location: `/app/workspaces/${workspace.id}/groups/${importedTeam.id}`,
  });
  expect(JSON.parse(String(event.fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
    template: teamTemplate,
    modelBindings: { researcher: binding },
    acknowledgements: [
      'create-bots',
      'create-memberships',
      'create-group-configuration',
      'no-source-access',
    ],
  });
});

it('rejects malformed templates, missing bindings and foreign origins before create', async () => {
  const event = context();
  expect(
    await teamImportAction(
      { ...event, request: request({ intent: 'preview', template: '{not-json' }) },
      workspace.id,
    ),
  ).toMatchObject({ status: 400 });
  expect(
    await teamImportAction(
      {
        ...event,
        request: request(
          { intent: 'preview', template: JSON.stringify(teamTemplate) },
          'http://evil.example',
        ),
      },
      workspace.id,
    ),
  ).toMatchObject({ status: 403 });
});

it('downloads the reviewed export without secrets or source identifiers', async () => {
  const event = context();
  const response = await downloadTeamTemplate(event, workspace.id, importedTeam.id);
  expect(response.headers.get('content-disposition')).toContain('team-template.json');
  const body = await response.text();
  expect(JSON.parse(body).template).toEqual(teamTemplate);
  expect(body).not.toContain('apiKey');
  expect(body).not.toContain('connectionId');
});

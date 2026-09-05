import { expect, it, vi } from 'vitest';
import {
  createBotTemplateApiClient,
  parseBotTemplate,
} from '../../src/lib/server/bot-template-api.js';
import { token, workspace } from '../fixtures/bots.js';
import { imported, preview, template } from '../fixtures/bot-template.js';

function client(payload: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
  return { request, api: createBotTemplateApiClient(request) };
}

it('accepts a versioned template export and a private owner import receipt', async () => {
  expect(parseBotTemplate({ ...template, connectionId: imported.id })).toBeUndefined();
  expect(await client({ template }).api.export(token, workspace.id, imported.id)).toEqual({
    status: 'available',
    value: template,
  });
  expect(await client({ preview }).api.preview(token, workspace.id, { template })).toEqual({
    status: 'available',
    value: preview,
  });
  const { api } = client({ bot: imported }, 201);
  expect(
    await api.import(token, workspace.id, {
      template,
      modelBinding: imported.currentVersion.configuration.modelBinding,
    }),
  ).toEqual({ status: 'available', value: imported });
});

it('rejects secret fields in export or preview payloads', async () => {
  expect(
    await client({
      template: { ...template, headers: { Authorization: 'secret' } },
    }).api.export(token, workspace.id, imported.id),
  ).toEqual({ status: 'unavailable' });
  expect(
    await client({
      preview: { ...preview, template: { ...template, sourceBotId: imported.id } },
    }).api.preview(token, workspace.id, { template }),
  ).toEqual({ status: 'unavailable' });
  expect(
    await client({ bot: { ...imported, visibility: 'workspace' } }, 201).api.import(
      token,
      workspace.id,
      {
        template,
        modelBinding: imported.currentVersion.configuration.modelBinding,
      },
    ),
  ).toEqual({ status: 'unavailable' });
});

import { expect, it, vi } from 'vitest';
import {
  createTeamTemplateApiClient,
  parseTeamTemplate,
} from '../../src/lib/server/team-template-api.js';
import { token, workspace } from '../fixtures/bots.js';
import { importedTeam, teamPreview, teamTemplate } from '../fixtures/team-template.js';

function client(payload: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
  return { request, api: createTeamTemplateApiClient(request) };
}

it('accepts a versioned team export and a detached group import receipt', async () => {
  expect(parseTeamTemplate({ ...teamTemplate, userId: importedTeam.id })).toBeUndefined();
  expect(
    await client({ template: teamTemplate }).api.export(token, workspace.id, importedTeam.id),
  ).toEqual({
    status: 'available',
    value: teamTemplate,
  });
  expect(
    await client({ preview: teamPreview }).api.preview(token, workspace.id, {
      template: teamTemplate,
    }),
  ).toEqual({
    status: 'available',
    value: teamPreview,
  });
  const { api } = client({ group: importedTeam }, 201);
  expect(
    await api.import(token, workspace.id, {
      template: teamTemplate,
      modelBindings: {},
      acknowledgements: [],
    }),
  ).toEqual({ status: 'available', value: importedTeam });
});

it('rejects secret fields in export or preview payloads', async () => {
  expect(
    await client({
      template: { ...teamTemplate, members: [{ userId: importedTeam.id }] },
    }).api.export(token, workspace.id, importedTeam.id),
  ).toEqual({ status: 'unavailable' });
});

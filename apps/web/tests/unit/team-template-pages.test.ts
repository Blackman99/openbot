import ImportPage from '../../src/routes/app/workspaces/[workspaceId]/groups/import/+page.svelte';
import { importedTeam, teamPreview, teamTemplate } from '../fixtures/team-template.js';
import { model } from '../fixtures/bot-template.js';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import { bot, user, workspace } from '../fixtures/bots.js';

const params = { workspaceId: workspace.id };
const data = {
  bot,
  user,
  workspace,
  workspaces: [workspace],
  bots: [bot],
  models: [model],
  modelsUnavailable: false,
};

function choice() {
  return JSON.stringify({
    scope: model.scope,
    connectionId: model.connectionId,
    modelId: model.modelId,
  });
}

it('lists every object to create and keeps import disabled until mappings and acknowledgements are complete', () => {
  const html = render(ImportPage, {
    props: {
      data,
      form: {
        values: { template: JSON.stringify(teamTemplate), acknowledgements: [], modelBindings: {} },
        preview: teamPreview,
      },
      params,
    },
  }).body;
  expect(html).toContain('Objects to create');
  expect(html).toContain('Group · Research desk');
  expect(html).toContain('Bot · Researcher');
  expect(html).toContain('Membership · researcher');
  expect(html).toContain('Collaboration limit');
  expect(html).toContain('Default budgets');
  expect(html).toContain('Default Lead · researcher');
  expect(html).toContain('create-bots');
  expect(html).toContain('no-source-access');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Create team/u);
  expect(html).not.toContain(importedTeam.id);
});

it('enables creation only after each Bot mapping and every acknowledgement is present', () => {
  const html = render(ImportPage, {
    props: {
      data,
      form: {
        values: {
          template: JSON.stringify(teamTemplate),
          acknowledgements: [
            'create-bots',
            'create-memberships',
            'create-group-configuration',
            'no-source-access',
          ],
          modelBindings: { researcher: choice() },
        },
        preview: {
          ...teamPreview,
          mappings: [{ botKey: 'researcher', requiredCapability: 'basic', bound: true }],
          acknowledgements: teamPreview.acknowledgements.map((row) => ({
            ...row,
            accepted: true,
          })),
          unresolved: false,
        },
      },
      params,
    },
  }).body;
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Create team/u);
  expect(html).toContain('Create team');
});

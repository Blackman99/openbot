import ImportPage from '../../src/routes/app/workspaces/[workspaceId]/bots/import/+page.svelte';
import { imported, model, preview, template } from '../fixtures/bot-template.js';
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

it('reviews complete instructions, capabilities, permissions, budgets and local differences before create is enabled', () => {
  const html = render(ImportPage, {
    props: {
      data,
      form: {
        values: { template: JSON.stringify(template), compareBotId: '', modelChoice: '' },
        preview,
      },
      params,
    },
  }).body;
  expect(html).toContain('Answer with cited sources.');
  expect(html).toContain('Keep spaces.');
  expect(html).toContain('Requested capabilities');
  expect(html).toContain('basic');
  expect(html).toContain('Declared collaboration visibility: private');
  expect(html).toContain('32768');
  expect(html).toContain('300');
  expect(html).toContain('Differences from the selected local Bot');
  expect(html).toContain('identity.name');
  expect(html).toContain(bot.name);
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Create independent Bot/u);
  expect(html).not.toContain(imported.id);
});

it('enables creation only after a compatible connection and model are bound', () => {
  const html = render(ImportPage, {
    props: {
      data,
      form: {
        values: {
          template: JSON.stringify(template),
          compareBotId: '',
          modelChoice: choice(),
        },
        preview,
      },
      params,
    },
  }).body;
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Create independent Bot/u);
  expect(html).toContain('Create independent Bot');
});

it('keeps creation disabled when the selected model lacks the declared capability', () => {
  const html = render(ImportPage, {
    props: {
      data,
      form: {
        values: {
          template: JSON.stringify(template),
          compareBotId: '',
          modelChoice: choice(),
        },
        preview: {
          ...preview,
          template: { ...template, capabilities: { required: 'collaboration' } },
        },
      },
      params,
    },
  }).body;
  expect(html).toContain('collaboration');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Create independent Bot/u);
});

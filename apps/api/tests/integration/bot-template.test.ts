import { afterEach, expect, it } from 'vitest';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { BOT_TEMPLATE_SCHEMA_VERSION } from '../../src/bots/template.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('exports a reviewable template without secrets and imports an independent Bot after binding', async () => {
  const f = await botAclFixture(cleanup);
  const exported = await f.app.inject({
    url: `${f.path}/${f.bot.id}/template`,
    headers: f.headers,
  });
  expect(exported.statusCode).toBe(200);
  expect(exported.headers['content-disposition']).toContain('bot-template.json');
  const template = exported.json().template;
  expect(template.schemaVersion).toBe(BOT_TEMPLATE_SCHEMA_VERSION);
  expect(template.identity.name).toBe('Private helper');
  expect(template.instructions).toBe('Instructions visible only with a direct Bot grant.');
  expect(template.capabilities).toEqual({ required: 'basic' });
  expect(template.collaboration).toEqual({ visibility: 'private' });
  expect(template.budgets).toMatchObject({ maxDurationSeconds: 300, maxTotalTokens: 32768 });
  const body = JSON.stringify(exported.json());
  expect(body).not.toContain(f.bot.id);
  expect(body).not.toContain(f.owner.workspace.id);
  expect(body).not.toContain(f.model.id);
  expect(body).not.toMatch(/apiKey|never-return-provider-secret|connectionId|headers/i);
  const outsider = await f.addUser();
  expect(
    (
      await f.app.inject({
        url: `${f.path}/${f.bot.id}/template`,
        headers: outsider.headers,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${f.owner.workspace.id}/bot-templates/previews`,
        headers: f.headers,
        payload: { template: { ...template, schemaVersion: 'nope' } },
      })
    ).json(),
  ).toEqual({
    error: {
      code: 'invalid_bot_template',
      fields: [{ field: 'schemaVersion', code: 'unsupported_schema' }],
    },
  });
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${f.owner.workspace.id}/bot-templates/previews`,
        headers: f.headers,
        payload: { template: { ...template, capabilities: { required: 'collaboration' } } },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${f.owner.workspace.id}/bot-templates`,
        headers: f.headers,
        payload: {
          template: { ...template, capabilities: { required: 'collaboration' } },
          modelBinding: {
            scope: { kind: 'personal', id: f.owner.user.id },
            connectionId: f.model.id,
            modelId: f.model.modelId,
          },
        },
      })
    ).json(),
  ).toEqual({
    error: {
      code: 'invalid_bot_template',
      fields: [{ field: 'capabilities.required', code: 'unmet_capability' }],
    },
  });
  const preview = await f.app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${f.owner.workspace.id}/bot-templates/previews`,
    headers: f.headers,
    payload: { template, compareBotId: f.bot.id },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().preview.differences).toEqual([]);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${f.owner.workspace.id}/bot-templates`,
        headers: f.headers,
        payload: { template },
      })
    ).statusCode,
  ).toBe(400);
  const imported = await f.app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${f.owner.workspace.id}/bot-templates`,
    headers: f.headers,
    payload: {
      template,
      modelBinding: {
        scope: { kind: 'personal', id: f.owner.user.id },
        connectionId: f.model.id,
        modelId: f.model.modelId,
      },
    },
  });
  expect(imported.statusCode).toBe(201);
  const bot = imported.json().bot;
  expect(bot.id).not.toBe(f.bot.id);
  expect(bot.workspaceId).toBe(f.owner.workspace.id);
  expect(bot.visibility).toBe('private');
  expect(bot.accessRole).toBe('owner');
  expect(bot.currentVersion.configuration.instructions).toBe(template.instructions);
  expect(JSON.stringify(bot)).not.toContain(f.bot.id);
  expect(bot.currentVersion.configuration.modelBinding.connectionId).toBe(f.model.id);
  expect(
    (await f.pool.query('SELECT user_id,role FROM bot_acl WHERE bot_id=$1', [bot.id])).rows,
  ).toEqual([{ user_id: f.owner.user.id, role: 'owner' }]);
  const source = await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers });
  expect(source.json().bot.currentVersion.id).toBe(f.bot.currentVersion.id);
  expect(source.json().bot.currentVersion.configuration.instructions).toBe(template.instructions);
  const reread = await f.app.inject({ url: `${f.path}/${bot.id}`, headers: f.headers });
  expect(reread.json().bot.currentVersion.id).not.toBe(f.bot.currentVersion.id);
  expect(reread.json().bot.currentVersion.number).toBe(1);
  expect(JSON.stringify(reread.json().bot)).not.toMatch(/sourceBotId|sourceWorkspaceId/);
});

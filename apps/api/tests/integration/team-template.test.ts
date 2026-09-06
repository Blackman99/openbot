import { afterEach, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupRoutingService } from '../../src/routing/service.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import {
  TEAM_TEMPLATE_ACKNOWLEDGEMENTS,
  TEAM_TEMPLATE_ROUTINE_ACKNOWLEDGEMENT,
  TEAM_TEMPLATE_SCHEMA_VERSION,
} from '../../src/groups/team-template.js';
import { TeamTemplateService } from '../../src/groups/team-template-service.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const f = await botAclFixture(cleanup);
  const groups = new GroupService(new PostgresGroupRepository(f.pool));
  const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
    name: 'Research desk',
    description: 'Find then write',
  });
  const bots = new BotService(new PostgresBotRepository(f.pool));
  const writer = await bots.create(f.owner.user.id, f.owner.workspace.id, {
    name: 'Writer',
    roleDescription: 'Writer',
    description: 'Drafts answers',
    instructions: 'Write from the research notes.',
    modelBinding: {
      scope: { kind: 'personal', id: f.owner.user.id },
      connectionId: f.model.id,
      modelId: f.model.modelId,
    },
  });
  const groupBots = new GroupBotService(new PostgresGroupBotRepository(f.pool));
  const researcherGrant = await groupBots.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
    botId: f.bot.id,
    idempotencyKey: 'invite-researcher',
  });
  await groupBots.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
    botId: writer.id,
    idempotencyKey: 'invite-writer',
  });
  await f.pool.query('UPDATE groups SET execution_policy=$2::jsonb WHERE id=$1', [
    group.id,
    JSON.stringify({
      maxConcurrentRuns: 4,
      maxDurationSeconds: 300,
      maxTurns: 8,
      maxDelegationDepth: 2,
    }),
  ]);
  await new GroupRoutingService(f.pool).update(f.owner.user.id, f.owner.workspace.id, group.id, {
    expectedRevision: 0,
    defaultGrantId: researcherGrant.id,
  });
  const teamTemplates = new TeamTemplateService(f.pool);
  const app = buildApp({
    auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
    bots,
    groups,
    groupBots,
    groupRouting: new GroupRoutingService(f.pool),
    teamTemplates,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  return {
    ...f,
    app,
    group,
    writer,
    teamTemplates,
    binding: {
      scope: { kind: 'personal' as const, id: f.owner.user.id },
      connectionId: f.model.id,
      modelId: f.model.modelId,
    },
  };
}

it('exports a safe team template and imports a detached copy only after mappings and acknowledgements', async () => {
  const f = await fixture();
  const exported = await f.app.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${f.group.id}/template`,
    headers: f.headers,
  });
  expect(exported.statusCode).toBe(200);
  expect(exported.headers['content-disposition']).toContain('team-template.json');
  const template = exported.json().template;
  expect(template.schemaVersion).toBe(TEAM_TEMPLATE_SCHEMA_VERSION);
  expect(template.identity).toEqual({ name: 'Research desk', description: 'Find then write' });
  expect(template.roles).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'Researcher' }),
      expect.objectContaining({ role: 'Writer' }),
    ]),
  );
  expect(template.defaultLead).toEqual({ botKey: expect.any(String) });
  expect(template.collaboration).toEqual({ maxConcurrentRuns: 4 });
  expect(template.budgets).toMatchObject({
    maxDurationSeconds: 300,
    maxTurns: 8,
    maxDelegationDepth: 2,
  });
  const body = JSON.stringify(exported.json());
  expect(body).not.toContain(f.group.id);
  expect(body).not.toContain(f.bot.id);
  expect(body).not.toContain(f.writer.id);
  expect(body).not.toContain(f.owner.workspace.id);
  expect(body).not.toContain(f.model.id);
  expect(body).not.toMatch(
    /apiKey|never-return-provider-secret|connectionId|headers|userId|email/i,
  );
  const outsider = await f.addUser();
  expect(
    (
      await f.app.inject({
        url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${f.group.id}/template`,
        headers: outsider.headers,
      })
    ).statusCode,
  ).toBe(403);
  const preview = await f.app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${f.owner.workspace.id}/team-templates/previews`,
    headers: f.headers,
    payload: { template },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().preview.objects.map((row: { kind: string }) => row.kind)).toEqual(
    expect.arrayContaining([
      'group',
      'bot',
      'membership',
      'collaboration',
      'budgets',
      'defaultLead',
    ]),
  );
  expect(preview.json().preview.unresolved).toBe(true);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${f.owner.workspace.id}/team-templates`,
        headers: f.headers,
        payload: { template },
      })
    ).json(),
  ).toEqual({
    error: {
      code: 'invalid_team_template',
      fields: expect.arrayContaining([
        expect.objectContaining({ code: 'unresolved_mapping' }),
        expect.objectContaining({ code: 'unresolved_acknowledgement' }),
      ]),
    },
  });
  const modelBindings = Object.fromEntries(
    template.bots.map((bot: { key: string }) => [bot.key, f.binding]),
  );
  const imported = await f.app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${f.owner.workspace.id}/team-templates`,
    headers: f.headers,
    payload: {
      template,
      modelBindings,
      acknowledgements: [...TEAM_TEMPLATE_ACKNOWLEDGEMENTS],
    },
  });
  expect(imported.statusCode).toBe(201);
  const created = imported.json();
  expect(created.group.id).not.toBe(f.group.id);
  expect(created.group.workspaceId).toBe(f.owner.workspace.id);
  expect(created.group.visibility).toBe('private');
  expect(created.bots).toHaveLength(2);
  expect(
    created.bots.every((bot: { id: string }) => bot.id !== f.bot.id && bot.id !== f.writer.id),
  ).toBe(true);
  const receipt = JSON.stringify(created);
  expect(receipt).not.toContain(f.group.id);
  expect(receipt).not.toContain(f.bot.id);
  expect(receipt).not.toMatch(/sourceWorkspaceId|sourceGroupId|sourceBotId/);
  const grants = (
    await f.pool.query('SELECT bot_id FROM group_bot_grants WHERE group_id=$1', [created.group.id])
  ).rows;
  expect(grants).toHaveLength(2);
});

it('rejects an import that cannot finish every membership', async () => {
  const f = await fixture();
  const template = await f.teamTemplates.export(f.owner.user.id, f.owner.workspace.id, f.group.id);
  const sample = template.bots[0]!;
  const oversized = {
    ...template,
    bots: Array.from({ length: 9 }, (_, index) => ({ ...sample, key: `helper-${index + 1}` })),
    roles: Array.from({ length: 9 }, (_, index) => ({
      botKey: `helper-${index + 1}`,
      role: 'Helper',
    })),
    defaultLead: { botKey: 'helper-1' },
  };
  await expect(
    f.teamTemplates.import(f.owner.user.id, f.owner.workspace.id, {
      template: oversized,
      modelBindings: Object.fromEntries(oversized.bots.map((bot) => [bot.key, f.binding])),
      acknowledgements: [...TEAM_TEMPLATE_ACKNOWLEDGEMENTS],
    }),
  ).rejects.toMatchObject({ code: 'group_bot_limit' });
});

it('imports later-schema routines disabled and keeps a cross-workspace copy detached', async () => {
  const f = await fixture();
  const template = await f.teamTemplates.export(f.owner.user.id, f.owner.workspace.id, f.group.id);
  const later = {
    ...template,
    schemaVersion: 'openbot.team-template.v1.routines',
    routines: [{ key: 'nightly-digest', name: 'Nightly digest' }],
  };
  const other = await new WorkspaceService(new PostgresWorkspaceRepository(f.pool)).create(
    f.owner.user.id,
    { name: 'Destination workspace' },
  );
  const imported = await f.teamTemplates.import(f.owner.user.id, other.id, {
    template: later,
    modelBindings: Object.fromEntries(later.bots.map((bot) => [bot.key, f.binding])),
    acknowledgements: [...TEAM_TEMPLATE_ACKNOWLEDGEMENTS, TEAM_TEMPLATE_ROUTINE_ACKNOWLEDGEMENT],
  });
  expect(imported.group.workspaceId).toBe(other.id);
  expect(imported.group.id).not.toBe(f.group.id);
  const routines = (
    await f.pool.query<{ enabled: boolean; routine_key: string }>(
      'SELECT enabled,routine_key FROM group_imported_routines WHERE group_id=$1',
      [imported.group.id],
    )
  ).rows;
  expect(routines).toEqual([{ enabled: false, routine_key: 'nightly-digest' }]);
  await expect(
    f.pool.query('UPDATE group_imported_routines SET enabled=true WHERE group_id=$1', [
      imported.group.id,
    ]),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query('SELECT user_id FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
        imported.group.id,
        f.owner.user.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.pool.query('SELECT id FROM group_bot_grants WHERE group_id=$1 AND bot_id=$2', [
        imported.group.id,
        f.bot.id,
      ])
    ).rows,
  ).toHaveLength(0);
  const destBots = (
    await f.pool.query<{ configuration: { modelBinding: { connectionId: string } } }>(
      'SELECT v.configuration FROM bots b JOIN bot_versions v ON v.id=b.current_version_id WHERE b.workspace_id=$1',
      [other.id],
    )
  ).rows;
  expect(destBots.every((row) => row.configuration.modelBinding.connectionId === f.model.id)).toBe(
    true,
  );
  expect(JSON.stringify(imported)).not.toContain(f.owner.workspace.id);
  expect(JSON.stringify(imported)).not.toContain(f.group.id);
});

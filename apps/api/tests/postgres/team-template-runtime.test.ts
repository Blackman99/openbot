import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { TEAM_TEMPLATE_ACKNOWLEDGEMENTS } from '../../src/groups/team-template.js';
import { TeamTemplateService } from '../../src/groups/team-template-service.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

(databaseUrl ? it : it.skip)(
  'rolls back every Bot, membership and group row when a later membership cannot be created',
  async () => {
    const schema = `team_tpl_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrateDatabase(pool);
      const ownerId = randomUUID();
      await pool.query(
        'INSERT INTO users (id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$3,NOW())',
        [ownerId, `${ownerId}@example.com`, 'Team owner'],
      );
      const workspace = await new WorkspaceService(new PostgresWorkspaceRepository(pool)).create(
        ownerId,
        { name: 'Team source' },
      );
      const providers = new ProviderConnections(
        new PostgresProviderRepository(pool),
        new ProviderSecretBox(randomBytes(32).toString('base64')),
        new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
        {
          run: async () => ({
            testedAt: new Date().toISOString(),
            text: { ok: true, code: 'passed', raw: 'OK' },
            action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
          }),
        },
      );
      const model = await providers.save(ownerId, {
        name: 'Basic',
        baseUrl: 'https://models.example/v1',
        modelId: 'model',
        apiKey: 'native-team-template-secret',
        headers: {},
      });
      const binding = {
        scope: { kind: 'personal' as const, id: ownerId },
        connectionId: model.id,
        modelId: model.modelId,
      };
      const bot = await new BotService(new PostgresBotRepository(pool)).create(
        ownerId,
        workspace.id,
        {
          name: 'Researcher',
          roleDescription: 'Researcher',
          instructions: 'Cite sources.',
          modelBinding: binding,
        },
      );
      const group = await new GroupService(new PostgresGroupRepository(pool)).create(
        ownerId,
        workspace.id,
        { name: 'Research desk', description: 'Find then write' },
      );
      await new GroupBotService(new PostgresGroupBotRepository(pool)).invite(
        ownerId,
        workspace.id,
        group.id,
        { botId: bot.id, idempotencyKey: 'source-invite' },
      );
      const templates = new TeamTemplateService(pool);
      const template = await templates.export(ownerId, workspace.id, group.id);
      const oversized = {
        ...template,
        bots: Array.from({ length: 9 }, (_, index) => ({
          ...template.bots[0]!,
          key: `helper-${index + 1}`,
        })),
        roles: Array.from({ length: 9 }, (_, index) => ({
          botKey: `helper-${index + 1}`,
          role: 'Helper',
        })),
        defaultLead: { botKey: 'helper-1' },
      };
      const before = {
        groups: (await pool.query('SELECT id FROM groups')).rows.length,
        bots: (await pool.query('SELECT id FROM bots')).rows.length,
        grants: (await pool.query('SELECT id FROM group_bot_grants')).rows.length,
      };
      await expect(
        templates.import(ownerId, workspace.id, {
          template: oversized,
          modelBindings: Object.fromEntries(oversized.bots.map((row) => [row.key, binding])),
          acknowledgements: [...TEAM_TEMPLATE_ACKNOWLEDGEMENTS],
        }),
      ).rejects.toMatchObject({ code: 'group_bot_limit' });
      expect((await pool.query('SELECT id FROM groups')).rows).toHaveLength(before.groups);
      expect((await pool.query('SELECT id FROM bots')).rows).toHaveLength(before.bots);
      expect((await pool.query('SELECT id FROM group_bot_grants')).rows).toHaveLength(
        before.grants,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);

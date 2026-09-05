import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { BotService } from '../../src/bots/service.js';
import { BotAclService } from '../../src/bots/acl-service.js';
import { PostgresBotAclRepository } from '../../src/bots/postgres-bot-acl-repository.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { newProviderDatabase } from './provider-database.js';

export async function botAclFixture(
  cleanup: Array<() => Promise<unknown>>,
  options: { onAclQuery?: (statement: string) => void; now?: () => Date } = {},
) {
  const pool: Pool = new (newProviderDatabase().adapters.createPg().Pool)();
  cleanup.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const session = randomBytes(32).toString('base64url');
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$bot-acl-test-only',
    generateSessionToken: () => session,
  });
  const owner = await auth.setup({
    email: 'owner@example.com',
    displayName: 'Bot owner',
    password: 'correct horse battery staple',
  });
  const headers = { cookie: `openbot_session=${session}`, origin: 'http://localhost:3000' };
  const providers = new ProviderConnections(
    new PostgresProviderRepository(pool),
    new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
    {
      run: async () => ({
        testedAt: new Date().toISOString(),
        text: { ok: true, code: 'passed', raw: 'Text' },
        action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
      }),
    },
  );
  const model = await providers.save(owner.user.id, {
    name: 'Private Basic',
    protocol: 'openai-chat',
    baseUrl: 'https://models.example/v1',
    modelId: 'test-model',
    apiKey: 'never-return-provider-secret',
    headers: {},
  });
  const aclPool: SqlPool = {
    connect: async () => {
      const connection = await pool.connect();
      return {
        query: async (statement, parameters) => {
          options.onAclQuery?.(statement);
          return connection.query(statement, parameters);
        },
        release: () => connection.release(),
      };
    },
  };
  const app = buildApp({
    auth,
    providers,
    bots: new BotService(new PostgresBotRepository(pool)),
    botAcl: new BotAclService(new PostgresBotAclRepository(aclPool, options.now)),
    members: new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(pool)),
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  const path = `/api/v1/workspaces/${owner.workspace.id}/bots`;
  const created = await app.inject({
    method: 'POST',
    url: path,
    headers,
    payload: {
      name: 'Private helper',
      roleDescription: 'Researcher',
      description: 'Discovery summary',
      instructions: 'Instructions visible only with a direct Bot grant.',
      modelBinding: {
        scope: { kind: 'personal', id: owner.user.id },
        connectionId: model.id,
        modelId: model.modelId,
      },
    },
  });
  if (created.statusCode !== 201)
    throw new Error(`Bot fixture creation failed: ${created.statusCode}`);
  const bot: { id: string; currentVersion: { id: string } } = created.json().bot;
  async function addUser(
    role: 'owner' | 'administrator' | 'member' = 'member',
    workspaceId = owner.workspace.id,
  ) {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url'),
      now = new Date();
    const email = `${id}@example.com`;
    await pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,$4)',
      [id, email, 'Workspace member', now],
    );
    await pool.query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4)',
      [workspaceId, id, role, now],
    );
    await new PostgresAuthRepository(pool).createSession({
      userId: id,
      tokenDigest: createHash('sha256').update(token).digest('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3600000),
      auditId: randomUUID(),
    });
    return { id, email, headers: { ...headers, cookie: `openbot_session=${token}` } };
  }
  return { pool, app, owner, headers, path, bot, addUser, providers, model };
}

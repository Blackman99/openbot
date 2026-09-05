import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../../api/dist/app.js';
import { migrateDatabase } from '../../../api/dist/database/migrations.js';
import { LocalAuthService } from '../../../api/dist/auth/service.js';
import { PostgresAuthRepository } from '../../../api/dist/auth/postgres-auth-repository.js';
import { ApiTokenService } from '../../../api/dist/api-tokens/service.js';
import { PostgresApiTokenRepository } from '../../../api/dist/api-tokens/postgres-repository.js';
import { BotService } from '../../../api/dist/bots/service.js';
import { PostgresBotRepository } from '../../../api/dist/bots/postgres-bot-repository.js';
import { BotVersionService } from '../../../api/dist/bots/version-service.js';
import { BotLifecycleService } from '../../../api/dist/bots/lifecycle-service.js';
import { BotAclService } from '../../../api/dist/bots/acl-service.js';
import { PostgresBotAclRepository } from '../../../api/dist/bots/postgres-bot-acl-repository.js';
import { BotAvatarService } from '../../../api/dist/bots/avatar-service.js';
import { LocalObjectStore } from '../../../api/dist/objects/local-store.js';
import { WorkspaceService } from '../../../api/dist/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../../api/dist/workspaces/postgres-workspace-repository.js';
import { ProviderConnections } from '../../../api/dist/providers/connections.js';
import { PostgresProviderRepository } from '../../../api/dist/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../../api/dist/providers/secrets.js';
import { ProviderUrlPolicy } from '../../../api/dist/providers/url-policy.js';

// Use the API package's declared test dependency. The application and every
// public/session operation are real; pg-mem does not prove PostgreSQL locking.
const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const { DataType, newDb } = requireApi('pg-mem');
let active;
let closing = Promise.resolve();
export function resetPublicBotFixture() {
  const previous = active;
  active = undefined;
  if (previous) closing = closing.then(() => previous.close());
  return closing;
}

async function setup(trustedOrigin) {
  await resetPublicBotFixture();
  const database = newDb({ noAstCoverageCheck: true });
  database.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 0,
  });
  const pool = new (database.adapters.createPg().Pool)();
  await migrateDatabase(pool, { installPostgresGuards: false });
  const session = randomBytes(32).toString('base64url');
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$public-bot-browser-fixture',
    generateSessionToken: () => session,
  });
  const owner = await auth.setup({
    email: 'public-bot@example.com',
    displayName: 'Public Bot owner',
    password: 'public-bot-browser-fixture-password',
  });
  const providers = new ProviderConnections(
    new PostgresProviderRepository(pool),
    new ProviderSecretBox(Buffer.alloc(32, 19).toString('base64')),
    new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
    {
      run: async () => ({
        testedAt: new Date().toISOString(),
        text: { ok: true, code: 'passed', raw: 'Fixture model text' },
        action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
      }),
    },
  );
  const model = await providers.save(owner.user.id, {
    name: 'Browser Basic',
    protocol: 'openai-chat',
    baseUrl: 'https://models.example/v1',
    modelId: 'browser-basic',
    apiKey: 'browser-provider-key-sentinel',
    headers: { 'x-private-header': 'browser-provider-header-sentinel' },
  });
  const directory = await mkdtemp(join(tmpdir(), 'openbot-public-bot-browser-'));
  const avatars = new BotAvatarService(pool, new LocalObjectStore(directory));
  const app = buildApp({
    auth,
    providers,
    avatars,
    bots: new BotService(new PostgresBotRepository(pool)),
    botVersions: new BotVersionService(pool, avatars),
    botLifecycle: new BotLifecycleService(pool),
    botAcl: new BotAclService(new PostgresBotAclRepository(pool)),
    apiTokens: new ApiTokenService(new PostgresApiTokenRepository(pool)),
    workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
    webOrigin: trustedOrigin,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  active = {
    app,
    close: async () => {
      await app.close();
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
  return {
    session,
    workspaceId: owner.workspace.id,
    userId: owner.user.id,
    modelBinding: {
      scope: { kind: 'personal', id: owner.user.id },
      connectionId: model.id,
      modelId: model.modelId,
    },
  };
}

export function handlePublicBotFixture(request, response, { sendJson, trustedOrigin }) {
  if (request.method === 'POST' && request.url === '/__public-bot/setup') {
    void setup(trustedOrigin)
      .then(({ session, ...result }) =>
        sendJson(response, 201, result, {
          'set-cookie': `openbot_session=${session}; Path=/; HttpOnly; SameSite=Lax`,
        }),
      )
      .catch((error) => {
        console.error(error);
        sendJson(response, 500, { error: 'public_bot_fixture_failed' });
      });
    return true;
  }
  if (!active || (!request.url.startsWith('/api/v1/') && !request.url.startsWith('/v1/')))
    return false;
  const app = active.app;
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const result = await app.inject({
      method: request.method,
      url: request.url,
      headers: request.headers,
      ...(body.length ? { payload: body } : {}),
    });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.rawPayload);
  })().catch((error) => {
    console.error(error);
    sendJson(response, 500, { error: 'public_bot_fixture_failed' });
  });
  return true;
}

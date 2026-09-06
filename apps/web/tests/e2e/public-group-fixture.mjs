import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../../api/dist/app.js';
import { migrateDatabase } from '../../../api/dist/database/migrations.js';
import { LocalAuthService } from '../../../api/dist/auth/service.js';
import { PostgresAuthRepository } from '../../../api/dist/auth/postgres-auth-repository.js';
import { ApiTokenService } from '../../../api/dist/api-tokens/service.js';
import { PostgresApiTokenRepository } from '../../../api/dist/api-tokens/postgres-repository.js';
import { GroupService } from '../../../api/dist/groups/service.js';
import { PostgresGroupRepository } from '../../../api/dist/groups/postgres-group-repository.js';
import { GroupBotService } from '../../../api/dist/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../../api/dist/group-bots/postgres-repository.js';
import { GroupRoutingService } from '../../../api/dist/routing/service.js';
import { ConversationService } from '../../../api/dist/conversations/service.js';
import { PostgresConversationRepository } from '../../../api/dist/conversations/postgres-repository.js';
import { WorkspaceService } from '../../../api/dist/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../../api/dist/workspaces/postgres-workspace-repository.js';
import { WorkspaceMemberService } from '../../../api/dist/members/service.js';
import { PostgresWorkspaceMemberRepository } from '../../../api/dist/members/postgres-member-repository.js';
import { InvitationService } from '../../../api/dist/invitations/service.js';
import { PostgresInvitationRepository } from '../../../api/dist/invitations/postgres-invitation-repository.js';

const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const { DataType, newDb } = requireApi('pg-mem');
let active;
let closing = Promise.resolve();
export function resetPublicGroupFixture() {
  const previous = active;
  active = undefined;
  if (previous) closing = closing.then(() => previous.close());
  return closing;
}

async function setup(trustedOrigin) {
  await resetPublicGroupFixture();
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
    hashPassword: async () => '$argon2id$public-group-browser-fixture',
    generateSessionToken: () => session,
  });
  const owner = await auth.setup({
    email: 'public-group@example.com',
    displayName: 'Public Group owner',
    password: 'public-group-browser-fixture-password',
  });
  const app = buildApp({
    auth,
    apiTokens: new ApiTokenService(new PostgresApiTokenRepository(pool)),
    groups: new GroupService(new PostgresGroupRepository(pool)),
    groupBots: new GroupBotService(new PostgresGroupBotRepository(pool)),
    groupRouting: new GroupRoutingService(pool),
    conversations: new ConversationService(new PostgresConversationRepository(pool)),
    workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
    members: new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(pool)),
    invitations: new InvitationService(
      new PostgresInvitationRepository(pool),
      () => new Date(),
      async () => '$argon2id$public-group-browser-fixture',
    ),
    webOrigin: trustedOrigin,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  active = {
    app,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
  return { session, workspaceId: owner.workspace.id, userId: owner.user.id };
}

export function handlePublicGroupFixture(request, response, { sendJson, trustedOrigin }) {
  if (request.method === 'POST' && request.url === '/__public-group/setup') {
    void setup(trustedOrigin)
      .then(({ session, ...result }) =>
        sendJson(response, 201, result, {
          'set-cookie': `openbot_session=${session}; Path=/; HttpOnly; SameSite=Lax`,
        }),
      )
      .catch((error) => {
        console.error(error);
        sendJson(response, 500, { error: 'public_group_fixture_failed' });
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
    sendJson(response, 500, { error: 'public_group_fixture_failed' });
  });
  return true;
}

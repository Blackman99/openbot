import { createRequire } from 'node:module';
import { buildApp } from '../../../api/dist/app.js';
import { migrateDatabase } from '../../../api/dist/database/migrations.js';
import { LocalAuthService } from '../../../api/dist/auth/service.js';
import { PostgresAuthRepository } from '../../../api/dist/auth/postgres-auth-repository.js';
import { InvitationService } from '../../../api/dist/invitations/service.js';
import { PostgresInvitationRepository } from '../../../api/dist/invitations/postgres-invitation-repository.js';
import { WorkspaceService } from '../../../api/dist/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../../api/dist/workspaces/postgres-workspace-repository.js';
import { BotService } from '../../../api/dist/bots/service.js';
import { PostgresBotRepository } from '../../../api/dist/bots/postgres-bot-repository.js';
import { GroupService } from '../../../api/dist/groups/service.js';
import { PostgresGroupRepository } from '../../../api/dist/groups/postgres-group-repository.js';
import { GroupBotService } from '../../../api/dist/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../../api/dist/group-bots/postgres-repository.js';
import { ConversationService } from '../../../api/dist/conversations/service.js';
import { PostgresConversationRepository } from '../../../api/dist/conversations/postgres-repository.js';
import { TaskService } from '../../../api/dist/tasks/service.js';
import { GroupRoutingService } from '../../../api/dist/routing/service.js';
import { ProviderConnections } from '../../../api/dist/providers/connections.js';
import { PostgresProviderRepository } from '../../../api/dist/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../../api/dist/providers/secrets.js';
import { ProviderUrlPolicy } from '../../../api/dist/providers/url-policy.js';

// Real Fastify/domain operations and the ordered migration registry, including
// 0021. pg-mem proves this browser flow, not native PostgreSQL locks or guards.
const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const { DataType, newDb } = requireApi('pg-mem');
let active;
let closing = Promise.resolve();
export function resetRoutingFixture() {
  const previous = active;
  active = undefined;
  if (previous) closing = closing.then(() => previous.close());
  return closing;
}

async function setup(trustedOrigin) {
  await resetRoutingFixture();
  const database = newDb({ noAstCoverageCheck: true });
  database.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 0,
  });
  const pool = new (database.adapters.createPg().Pool)();
  let app;
  try {
    await migrateDatabase(pool, { installPostgresGuards: false });
    const applied = (await pool.query('SELECT version FROM openbot_schema_migrations')).rows;
    if (!applied.some(({ version }) => version === '0021_deterministic_group_routing'))
      throw new Error('Routing browser fixture requires actual migration 0021');
    const hashPassword = async () => '$argon2id$routing-browser-fixture';
    const auth = new LocalAuthService(new PostgresAuthRepository(pool), { hashPassword });
    const owner = await auth.setup({
      email: 'routing-owner@example.com',
      displayName: 'Routing owner',
      password: 'routing-fixture-password',
    });
    const invitations = new InvitationService(
      new PostgresInvitationRepository(pool),
      () => new Date(),
      hashPassword,
    );
    const invitation = await invitations.create(owner.user.id, owner.workspace.id, {
      email: 'routing-member@example.com',
      role: 'member',
      expiresInDays: 1,
    });
    const member = await invitations.accept({
      token: invitation.token,
      email: invitation.invitation.email,
      displayName: 'Routing member',
      password: 'routing-member-fixture-password',
    });
    if (!member.session) throw new Error('Expected the newly invited member session');
    let probeCalls = 0;
    let seeding = true;
    const providers = new ProviderConnections(
      new PostgresProviderRepository(pool),
      new ProviderSecretBox(Buffer.alloc(32, 23).toString('base64')),
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      {
        run: async () => {
          probeCalls++;
          if (!seeding) throw new Error('Routing must not issue a provider probe');
          return {
            testedAt: new Date().toISOString(),
            text: { ok: true, code: 'passed', raw: 'routing-raw-probe-sentinel' },
            action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
          };
        },
      },
    );
    const workspaceProviders = providers.inWorkspace(owner.workspace.id);
    const bots = new BotService(new PostgresBotRepository(pool));
    const models = {};
    const createdBots = {};
    for (const [key, name, roleDescription, description] of [
      [
        'researcher',
        'Researcher',
        'Research and evidence specialist',
        'Compare sources and summarize findings',
      ],
      [
        'coder',
        'Coder',
        'TypeScript and database specialist',
        'Build TypeScript tools and database queries',
      ],
    ]) {
      const model = await workspaceProviders.save(owner.user.id, {
        name: `${name} Basic`,
        protocol: 'openai-chat',
        baseUrl: 'https://models.example/v1',
        modelId: `routing-${key}-model`,
        apiKey: 'routing-provider-key-sentinel',
        headers: { 'x-private-header': 'routing-provider-header-sentinel' },
      });
      models[key] = model;
      createdBots[key] = await bots.create(owner.user.id, owner.workspace.id, {
        name,
        roleDescription,
        description,
        instructions: 'TypeScript database routing-instructions-sentinel',
        modelBinding: {
          scope: { kind: 'workspace', id: owner.workspace.id },
          connectionId: model.id,
          modelId: model.modelId,
        },
      });
    }
    seeding = false;
    const groups = new GroupService(new PostgresGroupRepository(pool));
    const group = await groups.create(owner.user.id, owner.workspace.id, {
      name: 'Routing laboratory',
      description: 'A group with two private Bots and shared Basic models',
      visibility: 'private',
    });
    await groups.addMember(owner.user.id, owner.workspace.id, group.id, {
      userId: member.identity.user.id,
      role: 'member',
    });
    const groupBots = new GroupBotService(new PostgresGroupBotRepository(pool));
    const grants = {};
    for (const key of ['researcher', 'coder'])
      grants[key] = await groupBots.invite(owner.user.id, owner.workspace.id, group.id, {
        botId: createdBots[key].id,
        idempotencyKey: `routing-invite-${key}`,
        history: { mode: 'all' },
      });
    const conversationId = grants.researcher.conversationId;
    if (grants.coder.conversationId !== conversationId)
      throw new Error('Group grants must share the same conversation');
    const tasks = new TaskService(pool);
    const routingReads = [];
    app = buildApp({
      auth,
      providers,
      bots,
      groups,
      groupBots,
      conversations: new ConversationService(new PostgresConversationRepository(pool)),
      tasks,
      groupRouting: new GroupRoutingService(pool),
      workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
      webOrigin: trustedOrigin,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    const snapshot = async () => {
      const listed = await tasks.list(owner.user.id, owner.workspace.id, conversationId, {
        limit: '50',
      });
      const decisions = [];
      for (const task of listed.tasks)
        decisions.push({
          taskId: task.id,
          routing: await tasks.routing(owner.user.id, owner.workspace.id, conversationId, task.id),
        });
      const messages = await pool.query(
        "SELECT id FROM conversation_events WHERE conversation_id=$1 AND event_type='message.created'",
        [conversationId],
      );
      const taskRows = await pool.query('SELECT id FROM tasks WHERE conversation_id=$1', [
        conversationId,
      ]);
      const runs = await pool.query(
        'SELECT r.id FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=$1',
        [conversationId],
      );
      const receiptRows = await pool.query(
        'SELECT task_id FROM task_routing_decisions WHERE conversation_id=$1',
        [conversationId],
      );
      return {
        probeCalls,
        routingReads: [...routingReads],
        counts: {
          messages: messages.rows.length,
          tasks: taskRows.rows.length,
          runs: runs.rows.length,
          decisions: receiptRows.rows.length,
        },
        tasks: listed.tasks,
        decisions,
      };
    };
    active = {
      app,
      snapshot,
      sessions: { owner: owner.sessionToken, member: member.session.sessionToken },
      disableCoder: () => workspaceProviders.disable(owner.user.id, models.coder.id),
      routingReads,
      close: async () => {
        await app.close();
        await pool.end();
      },
    };
    return {
      session: owner.sessionToken,
      workspaceId: owner.workspace.id,
      groupId: group.id,
      conversationId,
      memberId: member.identity.user.id,
      bots: { researcher: createdBots.researcher.id, coder: createdBots.coder.id },
      grants: { researcher: grants.researcher.id, coder: grants.coder.id },
    };
  } catch (error) {
    if (app) await app.close();
    await pool.end();
    throw error;
  }
}

export function handleRoutingFixture(request, response, { sendJson, readJson, trustedOrigin }) {
  const failed = (error) => {
    console.error(error);
    sendJson(response, 500, { error: 'routing_fixture_failed' });
  };
  const cookie = (session) => ({
    'set-cookie': `openbot_session=${session}; Path=/; HttpOnly; SameSite=Lax`,
  });
  if (request.method === 'POST' && request.url === '/__routing/setup') {
    void setup(trustedOrigin)
      .then(({ session, ...result }) => sendJson(response, 201, result, cookie(session)))
      .catch(failed);
    return true;
  }
  const current = active;
  if (!current) return false;
  if (request.method === 'GET' && request.url === '/__routing/state') {
    void current
      .snapshot()
      .then((result) => sendJson(response, 200, result))
      .catch(failed);
    return true;
  }
  if (request.method === 'POST' && request.url === '/__routing/viewer') {
    readJson(request, ({ viewer }) => {
      if (viewer !== 'owner' && viewer !== 'member') {
        sendJson(response, 400, { error: 'invalid_routing_viewer' });
        return;
      }
      sendJson(response, 200, { ok: true }, cookie(current.sessions[viewer]));
    });
    return true;
  }
  if (request.method === 'POST' && request.url === '/__routing/disable-coder') {
    void current
      .disableCoder()
      .then(() => sendJson(response, 200, { ok: true }))
      .catch(failed);
    return true;
  }
  if (!request.url.startsWith('/api/v1/')) return false;
  const decisionRead = /\/tasks\/([^/?]+)\/routing(?:\?|$)/u.exec(request.url);
  if (request.method === 'GET' && decisionRead) current.routingReads.push(decisionRead[1]);
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const result = await current.app.inject({
      method: request.method,
      url: request.url,
      headers: request.headers,
      ...(body.length ? { payload: body } : {}),
    });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.rawPayload);
  })().catch(failed);
  return true;
}

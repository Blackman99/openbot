import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../../api/dist/app.js';
import { migrateDatabase } from '../../../api/dist/database/migrations.js';
import { LocalAuthService } from '../../../api/dist/auth/service.js';
import { PostgresAuthRepository } from '../../../api/dist/auth/postgres-auth-repository.js';
import { BotService } from '../../../api/dist/bots/service.js';
import { PostgresBotRepository } from '../../../api/dist/bots/postgres-bot-repository.js';
import { ConversationService } from '../../../api/dist/conversations/service.js';
import { PostgresConversationRepository } from '../../../api/dist/conversations/postgres-repository.js';
import { ConversationStreamService } from '../../../api/dist/conversations/stream-service.js';
import { cleanupConversationStreams } from '../../../api/dist/conversations/stream-cleanup.js';
import { TaskService } from '../../../api/dist/tasks/service.js';
import { TaskWorker } from '../../../api/dist/tasks/worker.js';
import { WorkspaceService } from '../../../api/dist/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../../api/dist/workspaces/postgres-workspace-repository.js';
import { ProviderConnections } from '../../../api/dist/providers/connections.js';
import { PostgresProviderRepository } from '../../../api/dist/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../../api/dist/providers/secrets.js';
import { ProviderUrlPolicy } from '../../../api/dist/providers/url-policy.js';
import { GroupService } from '../../../api/dist/groups/service.js';
import { PostgresGroupRepository } from '../../../api/dist/groups/postgres-group-repository.js';
import { GroupBotService } from '../../../api/dist/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../../api/dist/group-bots/postgres-repository.js';
import { MemoryService } from '../../../api/dist/memories/service.js';

const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const { DataType, newDb } = requireApi('pg-mem');
let active;
let closing = Promise.resolve();
function barrier() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function resetConversationStreamFixture() {
  const previous = active;
  active = undefined;
  if (previous) closing = closing.then(() => previous.close());
  return closing;
}
async function setup(trustedOrigin, groupMemory = false) {
  await resetConversationStreamFixture();
  // Real production Fastify, services, Worker and HTTP streaming. pg-mem is
  // only this browser fixture's database; native locking has a separate gate.
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
    hashPassword: async () => '$argon2id$conversation-stream-browser-fixture',
    generateSessionToken: () => session,
  });
  const owner = await auth.setup({
    email: 'stream@example.com',
    displayName: 'Stream owner',
    password: 'stream-browser-fixture-password',
  });
  const secrets = new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64'));
  const providers = new ProviderConnections(
    new PostgresProviderRepository(pool),
    secrets,
    new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
    {
      run: async () => ({
        testedAt: new Date().toISOString(),
        text: { ok: true, code: 'passed', raw: 'OK' },
        action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
      }),
    },
  );
  const model = await providers.save(owner.user.id, {
    name: 'Stream model',
    protocol: 'openai-chat',
    baseUrl: 'https://models.example/v1',
    modelId: 'stream-basic',
    apiKey: 'stream-private-provider-sentinel',
    headers: {},
  });
  const bots = new BotService(new PostgresBotRepository(pool));
  const bot = await bots.create(owner.user.id, owner.workspace.id, {
    name: 'Stream helper',
    roleDescription: 'Researcher',
    description: 'Streaming browser verification',
    instructions: 'Private stream instructions sentinel',
    modelBinding: {
      scope: { kind: 'personal', id: owner.user.id },
      connectionId: model.id,
      modelId: model.modelId,
    },
  });
  const conversations = new ConversationService(new PostgresConversationRepository(pool));
  const groups = new GroupService(new PostgresGroupRepository(pool));
  const groupBots = new GroupBotService(new PostgresGroupBotRepository(pool));
  const group = groupMemory
    ? await groups.create(owner.user.id, owner.workspace.id, { name: 'Live memory group' })
    : undefined;
  const conversation = await conversations.open(owner.user.id, owner.workspace.id, {
    subject: group ? { kind: 'group', id: group.id } : { kind: 'direct-bot', id: bot.id },
  });
  const grant = group
    ? await groupBots.invite(owner.user.id, owner.workspace.id, group.id, {
        botId: bot.id,
        idempotencyKey: 'stream-memory-grant',
        history: { mode: 'all' },
      })
    : undefined;
  const tasks = new TaskService(pool);
  const task = await tasks.submit(owner.user.id, owner.workspace.id, conversation.id, {
    idempotencyKey: 'stream-browser-task',
    body: 'Explain the stream evidence.',
    ...(grant ? { groupGrantId: grant.id } : {}),
  });
  const app = buildApp({
    auth,
    bots,
    conversations,
    tasks,
    ...(groupMemory ? { groups, groupBots, memories: new MemoryService(pool) } : {}),
    conversationStreams: new ConversationStreamService(pool),
    workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
    webOrigin: trustedOrigin,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  await app.ready();
  const first = barrier(),
    second = barrier(),
    next = barrier(),
    final = barrier();
  let workerPromise, humanSource;
  const worker = new TaskWorker(pool, {
    secrets,
    createAdapter: () => ({
      generate: async (_input, _signal, onEvent) => {
        await onEvent({ type: 'text', text: 'Live draft' });
        first.resolve();
        await next.promise;
        await onEvent({ type: 'text', text: ' plus more' });
        second.resolve();
        await final.promise;
        await onEvent({ type: 'complete', stopReason: 'stop' });
        return {
          raw: 'private diagnostic sentinel',
          events: [
            { type: 'text', text: 'Live draft' },
            { type: 'text', text: ' plus more' },
            { type: 'complete', stopReason: 'stop' },
          ],
        };
      },
    }),
  });
  const responses = new Set(),
    cursors = [];
  let bootstraps = 0;
  active = {
    app,
    pool,
    responses,
    cursors,
    noteBootstrap() {
      bootstraps++;
    },
    appendHuman: async () => {
      humanSource = await conversations.append(owner.user.id, owner.workspace.id, conversation.id, {
        idempotencyKey: 'live-human-source',
        body: 'Live group source version one.',
      });
    },
    editHuman: async () => {
      humanSource = await conversations.edit(
        owner.user.id,
        owner.workspace.id,
        conversation.id,
        humanSource.messageId,
        {
          idempotencyKey: 'live-human-source-edit',
          expectedVersion: 1,
          body: 'Live group source version two.',
        },
      );
    },
    closeGrant: () =>
      groupBots.remove(owner.user.id, owner.workspace.id, group.id, grant.id, {
        idempotencyKey: 'close-live-memory-grant',
      }),
    seedPage: async () => {
      for (let index = 1; index <= 30; index++)
        await conversations.append(owner.user.id, owner.workspace.id, conversation.id, {
          idempotencyKey: `stream-page-${index}`,
          body: `Seed message ${index}`,
        });
    },
    start: async () => {
      workerPromise ??= worker.runOnce();
      await first.promise;
    },
    next: async () => {
      next.resolve();
      await second.promise;
    },
    release: async () => {
      next.resolve();
      final.resolve();
      await workerPromise;
    },
    expire: async () => {
      // Append while the client transport is deliberately closed so its last
      // applied cursor is strictly below the atomically reclaimed prefix.
      await conversations.append(owner.user.id, owner.workspace.id, conversation.id, {
        idempotencyKey: 'retention-marker',
        body: 'Retention marker',
      });
      await cleanupConversationStreams(pool, new Date(Date.now() + 25 * 60 * 60 * 1000));
    },
    revoke: () =>
      pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
        owner.workspace.id,
        owner.user.id,
      ]),
    state: async () => ({
      task: (await pool.query('SELECT status FROM tasks WHERE id=$1', [task.id])).rows[0],
      run: (
        await pool.query('SELECT status,error_code,output_event_id FROM task_runs WHERE id=$1', [
          task.runs[0].id,
        ])
      ).rows[0],
      taskCount: (await pool.query('SELECT id FROM tasks')).rows.length,
      outputs: (
        await pool.query(
          "SELECT id,message_id,sequence,body FROM conversation_events WHERE bot_run_id=$1 AND event_type='bot.message.created'",
          [task.runs[0].id],
        )
      ).rows,
      delivery: (
        await pool.query(
          'SELECT sequence,event_type,run_status,delta_text FROM conversation_delivery_events WHERE conversation_id=$1 ORDER BY sequence',
          [conversation.id],
        )
      ).rows,
      cursors,
      bootstraps,
      humanSource,
      humanVersions: humanSource
        ? (
            await pool.query(
              'SELECT id,message_version AS version,idempotency_key FROM conversation_events WHERE message_id=$1 ORDER BY message_version',
              [humanSource.messageId],
            )
          ).rows
        : [],
      memories: (
        await pool.query(
          'SELECT v.memory_id,v.source_message_id,v.source_event_id,v.confidence,m.idempotency_key FROM memory_versions v JOIN group_memories m ON m.id=v.memory_id',
        )
      ).rows,
    }),
    close: async () => {
      for (const response of responses) response.destroy();
      next.resolve();
      final.resolve();
      await workerPromise;
      await app.close();
      await pool.end();
    },
  };
  return {
    session,
    workspaceId: owner.workspace.id,
    conversationId: conversation.id,
    taskId: task.id,
    runId: task.runs[0].id,
    ...(group ? { groupId: group.id, grantId: grant.id } : {}),
  };
}
export function handleConversationStreamFixture(request, response, { sendJson, trustedOrigin }) {
  if (
    request.method === 'POST' &&
    ['/__stream/setup', '/__stream/setup-group-memory'].includes(request.url)
  ) {
    void setup(trustedOrigin, request.url === '/__stream/setup-group-memory')
      .then(({ session, ...result }) =>
        sendJson(response, 201, result, {
          'set-cookie': `openbot_session=${session}; Path=/; HttpOnly; SameSite=Lax`,
        }),
      )
      .catch((error) => {
        console.error(error);
        sendJson(response, 500, { error: 'stream_fixture_failed' });
      });
    return true;
  }
  if (!active) return false;
  const fixture = active;
  if (request.url.startsWith('/__stream/')) {
    void (async () => {
      if (request.method === 'POST' && request.url === '/__stream/start') await fixture.start();
      else if (request.method === 'POST' && request.url === '/__stream/append-human')
        await fixture.appendHuman();
      else if (request.method === 'POST' && request.url === '/__stream/edit-human')
        await fixture.editHuman();
      else if (request.method === 'POST' && request.url === '/__stream/close-grant')
        await fixture.closeGrant();
      else if (request.method === 'POST' && request.url === '/__stream/seed-page')
        await fixture.seedPage();
      else if (request.method === 'POST' && request.url === '/__stream/next') await fixture.next();
      else if (request.method === 'POST' && request.url === '/__stream/release')
        await fixture.release();
      else if (request.method === 'POST' && request.url === '/__stream/expire')
        await fixture.expire();
      else if (request.method === 'POST' && request.url === '/__stream/revoke')
        await fixture.revoke();
      else if (request.method === 'POST' && request.url === '/__stream/disconnect') {
        for (const output of fixture.responses) output.destroy();
      } else if (request.method !== 'GET' || request.url !== '/__stream/state') {
        sendJson(response, 404, { error: 'fixture_route_missing' });
        return;
      }
      sendJson(response, 200, await fixture.state());
    })().catch((error) => {
      console.error(error);
      sendJson(response, 500, { error: 'stream_fixture_failed' });
    });
    return true;
  }
  if (!request.url.startsWith('/api/v1/')) return false;
  if (request.url.endsWith('/events')) {
    fixture.cursors.push(request.headers['last-event-id'] ?? null);
    fixture.responses.add(response);
    response.once('close', () => fixture.responses.delete(response));
  } else if (request.url.endsWith('/events/bootstrap')) fixture.noteBootstrap();
  // Inject buffers the complete response and cannot prove streaming. Route the
  // real IncomingMessage/ServerResponse through Fastify without an extra port.
  fixture.app.routing(request, response);
  return true;
}

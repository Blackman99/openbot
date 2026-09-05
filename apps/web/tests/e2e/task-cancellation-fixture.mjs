import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
import { TaskQueue } from '../../../api/dist/tasks/queue.js';
import { TaskWorker } from '../../../api/dist/tasks/worker.js';
import { WorkspaceService } from '../../../api/dist/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../../api/dist/workspaces/postgres-workspace-repository.js';
import { ProviderConnections } from '../../../api/dist/providers/connections.js';
import { PostgresProviderRepository } from '../../../api/dist/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../../api/dist/providers/secrets.js';
import { ProviderUrlPolicy } from '../../../api/dist/providers/url-policy.js';
import { createModelAdapter } from '../../../api/dist/providers/protocols.js';
import { GroupService } from '../../../api/dist/groups/service.js';
import { PostgresGroupRepository } from '../../../api/dist/groups/postgres-group-repository.js';
import { GroupBotService } from '../../../api/dist/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../../api/dist/group-bots/postgres-repository.js';
import { GroupRoutingService } from '../../../api/dist/routing/service.js';
const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const { DataType, newDb } = requireApi('pg-mem');
let active,
  closing = Promise.resolve();
export function resetTaskCancellationFixture() {
  const previous = active;
  active = undefined;
  if (previous) closing = closing.then(() => previous.close());
  return closing;
}
async function setup(trustedOrigin, inGroup = false, silent = false) {
  await resetTaskCancellationFixture();
  const database = newDb({ noAstCoverageCheck: true });
  database.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 0,
  });
  const pool = new (database.adapters.createPg().Pool)();
  await migrateDatabase(pool, { installPostgresGuards: false });
  // pg-mem names unnamed legacy CHECKs differently. Replace only the old
  // status checks; this fixture proves real HTTP/UI/worker behavior, not PG locks.
  for (const sql of [
    'ALTER TABLE tasks DROP CONSTRAINT tasks_constraint_1',
    'ALTER TABLE task_runs DROP CONSTRAINT task_runs_constraint_2',
    'ALTER TABLE task_runs DROP CONSTRAINT task_runs_constraint_8',
    'ALTER TABLE conversation_delivery_events DROP CONSTRAINT conversation_delivery_events_constraint_3',
    'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT task_run_delivery_receipts_constraint_1',
  ])
    await pool.query(sql);
  const ownerToken = randomBytes(32).toString('base64url');
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$cancellation-browser-fixture',
    generateSessionToken: () => ownerToken,
  });
  const owner = await auth.setup({
    email: 'cancel@example.com',
    displayName: 'Cancellation owner',
    password: 'cancellation-browser-fixture-password',
  });
  async function addUser(displayName) {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url'),
      now = new Date();
    await pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,$4)',
      [id, `${id}@example.com`, displayName, now],
    );
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'member',$3)",
      [owner.workspace.id, id, now],
    );
    await pool.query(
      'INSERT INTO sessions(token_digest,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)',
      [
        createHash('sha256').update(token).digest('hex'),
        id,
        now,
        new Date(now.getTime() + 86_400_000),
      ],
    );
    return { id, token };
  }
  const executor = inGroup
    ? await addUser('Original executor')
    : { id: owner.user.id, token: ownerToken };
  const moderator = inGroup ? await addUser('Cancellation moderator') : executor;
  const viewer = inGroup ? await addUser('Ordinary group member') : executor;
  let providerCalls = 0,
    providerClosed = false,
    providerResponse,
    requested;
  const requestArrived = new Promise((resolve) => {
    requested = resolve;
  });
  const provider = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      providerCalls++;
      providerResponse = response;
      response.on('error', () => {});
      response.on('close', () => {
        providerClosed = !response.writableFinished;
      });
      if (!silent) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"content":"<b>Interrupted 🌱</b>"}}]}\n\n');
      }
      requested();
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('missing_provider_port');
  const policy = new ProviderUrlPolicy({
    hosts: ['127.0.0.1'],
    schemes: ['http'],
    privateCidrs: ['127.0.0.0/8'],
  });
  const secrets = new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64'));
  const providers = new ProviderConnections(new PostgresProviderRepository(pool), secrets, policy, {
    run: async () => ({
      testedAt: new Date().toISOString(),
      text: { ok: true, code: 'passed', raw: 'OK' },
      action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
    }),
  });
  const scopedProviders = inGroup ? providers.inWorkspace(owner.workspace.id) : providers;
  const model = await scopedProviders.save(owner.user.id, {
    name: 'Cancellation model',
    protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    modelId: 'cancel-model',
    apiKey: 'cancel-provider-secret-sentinel',
    headers: {},
  });
  const bots = new BotService(new PostgresBotRepository(pool));
  const bot = await bots.create(owner.user.id, owner.workspace.id, {
    name: 'Cancellation helper',
    roleDescription: 'Assistant',
    instructions: 'Private cancellation instructions sentinel',
    modelBinding: {
      scope: {
        kind: inGroup ? 'workspace' : 'personal',
        id: inGroup ? owner.workspace.id : owner.user.id,
      },
      connectionId: model.id,
      modelId: model.modelId,
    },
  });
  const conversations = new ConversationService(new PostgresConversationRepository(pool));
  const groups = new GroupService(new PostgresGroupRepository(pool)),
    groupBots = new GroupBotService(new PostgresGroupBotRepository(pool));
  const group = inGroup
    ? await groups.create(owner.user.id, owner.workspace.id, { name: 'Cancellation group' })
    : undefined;
  if (group)
    for (const [user, role] of [
      [executor, 'member'],
      [moderator, 'admin'],
      [viewer, 'member'],
    ])
      await groups.addMember(owner.user.id, owner.workspace.id, group.id, {
        userId: user.id,
        role,
      });
  const conversation = await conversations.open(executor.id, owner.workspace.id, {
    subject: group ? { kind: 'group', id: group.id } : { kind: 'direct-bot', id: bot.id },
  });
  const grant = group
    ? await groupBots.invite(owner.user.id, owner.workspace.id, group.id, {
        botId: bot.id,
        idempotencyKey: 'cancel-grant',
      })
    : undefined;
  const tasks = new TaskService(pool),
    queue = new TaskQueue(pool);
  const task = await tasks.submit(executor.id, owner.workspace.id, conversation.id, {
    idempotencyKey: 'cancel-browser-task',
    body: 'Explain cancellation evidence.',
    ...(grant ? { groupGrantId: grant.id } : {}),
  });
  const app = buildApp({
    auth,
    bots,
    conversations,
    tasks,
    groups,
    groupBots,
    groupRouting: new GroupRoutingService(pool),
    conversationStreams: new ConversationStreamService(pool),
    workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
    webOrigin: trustedOrigin,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  await app.ready();
  const shutdown = new AbortController(),
    responses = new Set();
  let workerPromise,
    currentActor = inGroup ? moderator : executor;
  const worker = new TaskWorker(pool, {
    secrets,
    createAdapter: (protocol, options) => createModelAdapter(protocol, policy, options),
  });
  active = {
    app,
    responses,
    actor(name) {
      currentActor = name === 'executor' ? executor : name === 'viewer' ? viewer : moderator;
      return currentActor.token;
    },
    start: async () => {
      workerPromise ??= worker.runOnce(shutdown.signal);
      await requestArrived;
    },
    consumeQueued: () => worker.runOnce(shutdown.signal),
    settle: async () => {
      await workerPromise;
    },
    late: async () => {
      providerResponse?.write(
        'data: {"choices":[{"delta":{"content":" late forbidden"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
      providerResponse?.end();
      await workerPromise;
    },
    expire: async () => {
      for (const response of responses) response.destroy();
      await cleanupConversationStreams(pool, new Date(Date.now() + 25 * 60 * 60 * 1000));
    },
    revoke: () =>
      group
        ? groups.removeMember(owner.user.id, owner.workspace.id, group.id, currentActor.id)
        : pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
            owner.workspace.id,
            currentActor.id,
          ]),
    closeAdmission: async () => {
      await scopedProviders.disable(owner.user.id, model.id);
      if (grant)
        await groupBots.remove(owner.user.id, owner.workspace.id, group.id, grant.id, {
          idempotencyKey: 'close-cancel-grant',
        });
    },
    advance: async () => {
      const claimed = (await queue.claimNext()).claim;
      if (!claimed) throw new Error('missing_retry_claim');
      await queue.finish(claimed, { error: 'provider_failed', usage: null });
      await tasks.retry(executor.id, owner.workspace.id, conversation.id, task.id, {
        idempotencyKey: 'fixture-retry',
        expectedRunId: claimed.runId,
      });
    },
    state: async () => ({
      task: (await pool.query('SELECT status FROM tasks WHERE id=$1', [task.id])).rows[0],
      runs: (
        await pool.query(
          'SELECT id,status,started_at,finished_at,error_code,output_event_id FROM task_runs WHERE task_id=$1 ORDER BY attempt',
          [task.id],
        )
      ).rows,
      taskCount: (await pool.query('SELECT id FROM tasks')).rows.length,
      prompts: (
        await pool.query(
          "SELECT id FROM conversation_events WHERE event_type='message.created' AND body='Explain cancellation evidence.'",
        )
      ).rows.length,
      outputs: (
        await pool.query(
          "SELECT id,body FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
      partials: (await pool.query('SELECT body,end_byte FROM task_run_partial_outputs')).rows,
      commands: (
        await pool.query(
          'SELECT id,idempotency_key,expected_run_id,affected_task_count,affected_run_count FROM task_cancel_commands',
        )
      ).rows,
      providerCalls,
      providerClosed,
    }),
    close: async () => {
      for (const response of responses) response.destroy();
      shutdown.abort();
      await workerPromise;
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await app.close();
      await pool.end();
    },
  };
  return {
    session: currentActor.token,
    workspaceId: owner.workspace.id,
    conversationId: conversation.id,
    taskId: task.id,
    runId: task.runs[0].id,
    ...(group ? { groupId: group.id, grantId: grant.id } : {}),
  };
}
export function handleTaskCancellationFixture(request, response, { sendJson, trustedOrigin }) {
  if (
    request.method === 'POST' &&
    ['/__cancel/setup', '/__cancel/setup-group', '/__cancel/setup-silent'].includes(request.url)
  ) {
    void setup(
      trustedOrigin,
      request.url === '/__cancel/setup-group',
      request.url === '/__cancel/setup-silent',
    )
      .then(({ session, ...result }) =>
        sendJson(response, 201, result, {
          'set-cookie': `openbot_session=${session}; Path=/; HttpOnly; SameSite=Lax`,
        }),
      )
      .catch((error) => {
        console.error(error);
        sendJson(response, 500, { error: 'cancellation_fixture_failed' });
      });
    return true;
  }
  if (!active) return false;
  const fixture = active;
  if (request.url.startsWith('/__cancel/')) {
    void (async () => {
      const actions = {
        '/__cancel/start': 'start',
        '/__cancel/consume-queued': 'consumeQueued',
        '/__cancel/settle': 'settle',
        '/__cancel/late': 'late',
        '/__cancel/expire': 'expire',
        '/__cancel/revoke': 'revoke',
        '/__cancel/close-admission': 'closeAdmission',
        '/__cancel/advance': 'advance',
      };
      if (request.method === 'POST' && actions[request.url]) await fixture[actions[request.url]]();
      else if (request.method === 'POST' && request.url.startsWith('/__cancel/actor/')) {
        const token = fixture.actor(request.url.split('/').at(-1));
        sendJson(response, 200, await fixture.state(), {
          'set-cookie': `openbot_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
        });
        return;
      } else if (request.method !== 'GET' || request.url !== '/__cancel/state') {
        sendJson(response, 404, { error: 'fixture_route_missing' });
        return;
      }
      sendJson(response, 200, await fixture.state());
    })().catch((error) => {
      console.error(error);
      sendJson(response, 500, { error: 'cancellation_fixture_failed' });
    });
    return true;
  }
  if (!request.url.startsWith('/api/v1/')) return false;
  if (request.url.endsWith('/events')) {
    fixture.responses.add(response);
    response.once('close', () => fixture.responses.delete(response));
  }
  fixture.app.routing(request, response);
  return true;
}

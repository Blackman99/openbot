import { afterEach, describe, expect, it } from 'vitest';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import type { ModelEvent } from '../../src/providers/model-events.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { TaskService } from '../../src/tasks/service.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';

describe('durable single-Bot execution', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  it('executes the durable queued attempt outside its submission process and publishes one fenced Bot-authored response', async () => {
    const f = await botAclFixture(cleanup);
    const conversation = await new ConversationService(
      new PostgresConversationRepository(f.pool),
    ).open(f.owner.user.id, f.owner.workspace.id, {
      subject: { kind: 'direct-bot', id: f.bot.id },
    });
    const tasks = new TaskService(f.pool);
    const submitted = await tasks.submit(f.owner.user.id, f.owner.workspace.id, conversation.id, {
      idempotencyKey: 'execute',
      body: 'What did you find?',
    });
    let calls = 0;
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: (protocol, options) => ({
        generate: async (input, signal, onEvent) => {
          calls++;
          expect(protocol).toBe('openai-chat');
          expect(options.timeoutMs).toBeGreaterThan(15000);
          expect(input.apiKey).toBe('never-return-provider-secret');
          expect(input.modelId).toBe('test-model');
          expect(input.maxOutputTokens).toBeGreaterThan(256);
          expect(input.messages).toEqual([
            { role: 'system', content: 'Instructions visible only with a direct Bot grant.' },
            { role: 'user', content: 'What did you find?' },
          ]);
          expect(signal?.aborted).toBe(false);
          expect(
            (await tasks.get(f.owner.user.id, f.owner.workspace.id, conversation.id, submitted.id))
              .status,
          ).toBe('running');
          const events: ModelEvent[] = [
            { type: 'text', text: 'The evidence is complete.' },
            { type: 'usage', inputTokens: 15, outputTokens: 5 },
            { type: 'usage', inputTokens: 15, outputTokens: 5 },
            { type: 'complete', stopReason: 'stop' },
          ];
          for (const event of events) await onEvent?.(event);
          expect(
            (await tasks.get(f.owner.user.id, f.owner.workspace.id, conversation.id, submitted.id))
              .status,
          ).toBe('running');
          return { events, raw: 'raw diagnostic must not be saved' };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(1);
    const final = await new TaskService(f.pool).get(
      f.owner.user.id,
      f.owner.workspace.id,
      conversation.id,
      submitted.id,
    );
    const savedOutputs = (
      await f.pool.query(
        "SELECT id,message_id,sequence FROM conversation_events WHERE conversation_id=$1 AND bot_run_id=$2 AND event_type='bot.message.created'",
        [conversation.id, submitted.runs[0]!.id],
      )
    ).rows;
    expect(savedOutputs).toHaveLength(1);
    const output = savedOutputs[0];
    expect(Number(output.sequence)).toBeGreaterThan(submitted.trigger.sequence);
    expect(final).toMatchObject({
      status: 'completed',
      runs: [
        {
          attempt: 1,
          status: 'completed',
          provider: { protocol: 'openai-chat', modelId: 'test-model' },
          usage: { inputTokens: 15, outputTokens: 5 },
          error: null,
          output: {
            messageId: output.message_id,
            eventId: output.id,
            sequence: Number(output.sequence),
          },
        },
      ],
    });
    const page = await new ConversationService(new PostgresConversationRepository(f.pool)).get(
      f.owner.user.id,
      f.owner.workspace.id,
      conversation.id,
      {},
    );
    expect(page.messages).toHaveLength(2);
    expect(page.messages[1]).toMatchObject({
      body: 'The evidence is complete.',
      author: {
        kind: 'bot',
        id: f.bot.id,
        displayName: 'Private helper',
        versionId: f.bot.currentVersion.id,
        versionNumber: 1,
      },
      canEdit: false,
      canDelete: false,
      canAudit: false,
    });
    expect(JSON.stringify(final)).not.toMatch(
      /never-return|raw diagnostic|Instructions|sealed|claimToken/,
    );
  });
  it('lets an ordinary group member address an exact active grant without direct Bot ACL or borrowed personal credentials', async () => {
    const f = await botAclFixture(cleanup);
    const member = await f.addUser();
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Execution group',
    });
    await groups.addMember(f.owner.user.id, f.owner.workspace.id, group.id, {
      userId: member.id,
      role: 'member',
    });
    const shared = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
      name: 'Shared execution',
      baseUrl: 'https://models.example/v1',
      modelId: 'shared-model',
      apiKey: 'shared-private-secret',
      headers: {},
    });
    const sharedBot = await new BotService(new PostgresBotRepository(f.pool)).create(
      f.owner.user.id,
      f.owner.workspace.id,
      {
        name: 'Shared helper',
        roleDescription: 'Assistant',
        instructions: 'Private shared instructions',
        modelBinding: {
          scope: { kind: 'workspace', id: f.owner.workspace.id },
          connectionId: shared.id,
          modelId: shared.modelId,
        },
      },
    );
    const grants = new GroupBotService(new PostgresGroupBotRepository(f.pool));
    const grant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
      botId: sharedBot.id,
      idempotencyKey: 'shared-invite',
    });
    const privateGrant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
      botId: f.bot.id,
      idempotencyKey: 'private-invite',
    });
    const app = buildApp({
      auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
      tasks: new TaskService(f.pool),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${grant.conversationId}/tasks`,
      headers: member.headers,
      payload: {
        idempotencyKey: 'group-task',
        body: 'Please answer here.',
        groupGrantId: grant.id,
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().task).toMatchObject({
      groupGrantId: grant.id,
      bot: { id: sharedBot.id },
      executionUser: { id: member.id },
      status: 'queued',
    });
    expect(
      (
        await f.pool.query('SELECT role FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
          sharedBot.id,
          member.id,
        ])
      ).rows,
    ).toHaveLength(0);
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${grant.conversationId}/tasks`,
      headers: member.headers,
      payload: {
        idempotencyKey: 'no-proxy',
        body: 'Do not borrow inviter credentials.',
        groupGrantId: privateGrant.id,
      },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({ error: { code: 'task_model_unavailable' } });
    expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT body FROM conversation_events WHERE event_type='message.created'",
        )
      ).rows,
    ).toEqual([{ body: 'Please answer here.' }]);
    expect(response.body).not.toMatch(/Private shared|shared-private|connectionId|instructions/);
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          expect(input.apiKey).toBe('shared-private-secret');
          expect(input.modelId).toBe('shared-model');
          expect(input.messages).toEqual([
            { role: 'system', content: 'Private shared instructions' },
            { role: 'user', content: 'Please answer here.' },
          ]);
          return {
            events: [
              { type: 'text', text: 'Shared answer.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    const tasks = new TaskService(f.pool);
    expect(
      await tasks.get(
        member.id,
        f.owner.workspace.id,
        grant.conversationId,
        response.json().task.id,
      ),
    ).toMatchObject({ status: 'completed' });
    const humanContext = await grants.context(
      member.id,
      f.owner.workspace.id,
      group.id,
      grant.id,
      {},
    );
    expect(humanContext.messages.map((message) => message.body)).toEqual(['Please answer here.']);
    const pending = await tasks.submit(member.id, f.owner.workspace.id, grant.conversationId, {
      idempotencyKey: 'old-grant',
      body: 'Old grant must stay closed.',
      groupGrantId: grant.id,
    });
    await grants.remove(f.owner.user.id, f.owner.workspace.id, group.id, grant.id, {
      idempotencyKey: 'remove-shared',
    });
    const replacement = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
      botId: sharedBot.id,
      idempotencyKey: 'reinvite',
    });
    expect(replacement.id).not.toBe(grant.id);
    let lateCalls = 0;
    const neverCall = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async () => {
          lateCalls++;
          throw new Error('Closed grant must not execute');
        },
      }),
    });
    expect(await neverCall.runOnce()).toBe(true);
    expect(lateCalls).toBe(0);
    expect(
      await tasks.get(member.id, f.owner.workspace.id, grant.conversationId, pending.id),
    ).toMatchObject({
      status: 'failed',
      groupGrantId: grant.id,
      runs: [{ error: 'execution_forbidden', output: null }],
    });
    const duringCall = await tasks.submit(member.id, f.owner.workspace.id, grant.conversationId, {
      idempotencyKey: 'new-grant',
      body: 'Revoke while answering.',
      groupGrantId: replacement.id,
    });
    const revokedWorker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          expect(input.messages).toEqual([
            { role: 'system', content: 'Private shared instructions' },
            { role: 'user', content: 'Revoke while answering.' },
          ]);
          await grants.remove(f.owner.user.id, f.owner.workspace.id, group.id, replacement.id, {
            idempotencyKey: 'remove-during-call',
          });
          return {
            events: [
              { type: 'text', text: 'Must not publish.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await revokedWorker.runOnce()).toBe(true);
    expect(
      await tasks.get(member.id, f.owner.workspace.id, grant.conversationId, duringCall.id),
    ).toMatchObject({ status: 'failed', runs: [{ error: 'execution_forbidden', output: null }] });
    expect(
      (
        await f.pool.query(
          "SELECT body FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toEqual([{ body: 'Shared answer.' }]);
  });
  it('atomically submits a direct message and its first queued Task/Run and replays its original receipt', async () => {
    const f = await botAclFixture(cleanup);
    const conversation = await new ConversationService(
      new PostgresConversationRepository(f.pool),
    ).open(f.owner.user.id, f.owner.workspace.id, {
      subject: { kind: 'direct-bot', id: f.bot.id },
    });
    const app = buildApp({
      tasks: new TaskService(f.pool),
      conversations: new ConversationService(new PostgresConversationRepository(f.pool)),
      auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const submit = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}/tasks`,
        headers: f.headers,
        payload: { idempotencyKey: 'first-task', body: 'Please explain the result.' },
      });
    const first = await submit();
    expect(first.statusCode).toBe(202);
    const task = first.json().task;
    expect(task).toMatchObject({
      id: expect.any(String),
      conversationId: conversation.id,
      status: 'queued',
      bot: { id: f.bot.id, versionId: f.bot.currentVersion.id },
      executionUser: { id: f.owner.user.id },
      runs: [{ id: expect.any(String), attempt: 1, status: 'queued', provider: null, error: null }],
    });
    expect((await submit()).json()).toEqual(first.json());
    const ordinaryReplay = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}/messages`,
      headers: f.headers,
      payload: { idempotencyKey: 'first-task', body: 'Please explain the result.' },
    });
    expect(ordinaryReplay.statusCode).toBe(409);
    expect(ordinaryReplay.json()).toEqual({ error: { code: 'idempotency_conflict' } });
    await f.providers.disable(f.owner.user.id, f.model.id);
    const reloaded = await app.inject({
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}/tasks/${task.id}`,
      headers: f.headers,
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toEqual(first.json());
    const listed = await app.inject({
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}/tasks`,
      headers: f.headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      conversationId: conversation.id,
      tasks: [task],
      nextCursor: null,
    });
    expect(task.runs[0]).toMatchObject({
      startedAt: null,
      finishedAt: null,
      provider: null,
      usage: null,
      error: null,
      output: null,
    });
    expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(1);
    expect((await f.pool.query('SELECT event_type,body FROM conversation_events')).rows).toEqual([
      { event_type: 'message.created', body: 'Please explain the result.' },
    ]);
    expect(first.body).not.toMatch(
      /Instructions visible|never-return|connectionId|sealed|claimToken/,
    );
  });
});

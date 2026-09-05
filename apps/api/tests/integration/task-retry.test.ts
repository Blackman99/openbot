import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { taskFixture } from '../helpers/task-fixture.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import { encodeRunHistoryCursor } from '../../src/tasks/run-history.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotVersionService } from '../../src/bots/version-service.js';
import { GroupRoutingService } from '../../src/routing/service.js';
import { parseTask } from '../../../web/src/lib/server/task-contract.js';

describe('failed Task retry', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  async function fixture() {
    return taskFixture(cleanup);
  }
  function taskApp(f: Awaited<ReturnType<typeof fixture>>) {
    const app = buildApp({
      auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
      tasks: f.tasks,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    return app;
  }

  it.each(['edited', 'deleted'] as const)(
    'respects a currently %s trigger without historical-body replay or later-created context',
    async (revision) => {
      const f = await fixture();
      await f
        .worker(async () => {
          throw new Error('original failure');
        })
        .runOnce();
      const saved = (
        await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [f.task.runs[0]!.id])
      ).rows[0];
      const access = [
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        f.task.trigger.messageId,
      ] as const;
      if (revision === 'edited')
        await f.conversations.edit(...access, {
          idempotencyKey: 'correct-trigger',
          expectedVersion: 1,
          body: 'Corrected current question.',
        });
      else
        await f.conversations.tombstone(...access, {
          idempotencyKey: 'delete-trigger',
          expectedVersion: 1,
        });
      await f.conversations.append(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
        idempotencyKey: 'later-message',
        body: 'Later messages are outside this Task horizon.',
      });
      const result = await f.tasks.retry(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        f.task.id,
        { idempotencyKey: 'retry-current-source', expectedRunId: f.task.runs[0]!.id },
      );
      expect(result.task.trigger).toEqual(f.task.trigger);
      let calls = 0;
      await f
        .worker(async (input) => {
          calls++;
          expect(input.messages).toEqual([
            { role: 'system', content: 'Instructions visible only with a direct Bot grant.' },
            ...(revision === 'edited'
              ? [{ role: 'user', content: 'Corrected current question.' }]
              : []),
          ]);
          throw new Error('safe provider failure after current-source inspection');
        })
        .runOnce();
      expect(calls).toBe(1);
      expect(
        (await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [f.task.runs[0]!.id])).rows[0],
      ).toEqual(saved);
    },
  );

  it.each(['mention', 'local-match'] as const)(
    'keeps the original human, pinned configuration and %s routing through the exact retained group grant',
    async (reason) => {
      const f = await fixture(),
        app = taskApp(f),
        member = await f.addUser();
      await f
        .worker(async () => {
          throw new Error('finish unrelated direct fixture task');
        })
        .runOnce();
      const groups = new GroupService(new PostgresGroupRepository(f.pool));
      const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
        name: 'Retry group',
      });
      await groups.addMember(f.owner.user.id, f.owner.workspace.id, group.id, {
        userId: member.id,
        role: 'member',
      });
      const shared = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
        name: 'Shared model',
        baseUrl: 'https://models.example/v1',
        modelId: 'original-shared-model',
        apiKey: 'shared-secret',
        headers: {},
      });
      const bots = new BotService(new PostgresBotRepository(f.pool));
      const bot = await bots.create(f.owner.user.id, f.owner.workspace.id, {
        name: 'Original Bot',
        roleDescription: 'Assistant',
        instructions: 'Original immutable instructions.',
        modelBinding: {
          scope: { kind: 'workspace', id: f.owner.workspace.id },
          connectionId: shared.id,
          modelId: shared.modelId,
        },
      });
      const versionId = bot.currentVersion?.id;
      if (!versionId) throw new Error('expected_created_bot_version');
      const grants = new GroupBotService(new PostgresGroupBotRepository(f.pool));
      const grant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
        botId: bot.id,
        idempotencyKey: 'invite-original',
      });
      const task = await f.tasks.submit(member.id, f.owner.workspace.id, grant.conversationId, {
        idempotencyKey: 'member-task',
        ...(reason === 'mention' ? { groupGrantId: grant.id } : {}),
        body: 'Use the original configuration.',
      });
      const decision = await f.tasks.routing(
        member.id,
        f.owner.workspace.id,
        grant.conversationId,
        task.id,
      );
      const decisionRow = (
        await f.pool.query('SELECT * FROM task_routing_decisions WHERE task_id=$1', [task.id])
      ).rows[0];
      expect(decision.reason).toBe(reason);
      await f
        .worker(async () => {
          throw new Error('first member attempt failed');
        })
        .runOnce();
      const replacement = await f.providers
        .inWorkspace(f.owner.workspace.id)
        .save(f.owner.user.id, {
          name: 'Replacement model',
          baseUrl: 'https://models.example/v1',
          modelId: 'replacement-model',
          apiKey: 'replacement-secret',
          headers: {},
        });
      await new BotVersionService(f.pool, {
        read: async () => {
          throw new Error('avatar_not_used');
        },
      }).edit(
        { actorUserId: f.owner.user.id, workspaceId: f.owner.workspace.id, botId: bot.id },
        {
          expectedCurrentVersionId: versionId,
          changes: {
            name: 'Changed Bot',
            instructions: 'Changed instructions.',
            modelBinding: {
              scope: { kind: 'workspace', id: f.owner.workspace.id },
              connectionId: replacement.id,
              modelId: replacement.modelId,
            },
          },
        },
      );
      const defaultBot = await bots.create(f.owner.user.id, f.owner.workspace.id, {
        name: 'New default',
        roleDescription: 'Replacement assistant',
        instructions: 'Do not use this default for a retained retry.',
        modelBinding: {
          scope: { kind: 'workspace', id: f.owner.workspace.id },
          connectionId: replacement.id,
          modelId: replacement.modelId,
        },
      });
      const defaultGrant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
        botId: defaultBot.id,
        idempotencyKey: 'invite-new-default',
      });
      await new GroupRoutingService(f.pool).update(
        f.owner.user.id,
        f.owner.workspace.id,
        group.id,
        {
          expectedRevision: 0,
          defaultGrantId: defaultGrant.id,
        },
      );
      const url = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${grant.conversationId}/tasks/${task.id}`;
      const payload = { idempotencyKey: 'original-member-retry', expectedRunId: task.runs[0]!.id };
      expect((await app.inject({ url, headers: f.headers })).statusCode).toBe(200);
      const ownerRetry = await app.inject({
        method: 'POST',
        url: url + '/retries',
        headers: f.headers,
        payload,
      });
      expect(ownerRetry.statusCode).toBe(403);
      expect(ownerRetry.json()).toEqual({ error: { code: 'task_forbidden' } });
      const retried = await app.inject({
        method: 'POST',
        url: url + '/retries',
        headers: member.headers,
        payload,
      });
      expect(retried.statusCode).toBe(202);
      expect(retried.json()).toMatchObject({
        task: {
          executionUser: { id: member.id },
          groupGrantId: grant.id,
          bot: { name: 'Original Bot', versionId },
          trigger: JSON.parse(JSON.stringify(task.trigger)),
          runCount: 2,
          routing: { algorithm: 'local-terms-v1', reason },
        },
      });
      expect(parseTask(retried.json().task, grant.conversationId)?.routing).toEqual(task.routing);
      expect(
        await f.tasks.routing(member.id, f.owner.workspace.id, grant.conversationId, task.id),
      ).toEqual(decision);
      expect(
        (await f.pool.query('SELECT * FROM task_routing_decisions WHERE task_id=$1', [task.id]))
          .rows,
      ).toEqual([decisionRow]);
      expect(
        (
          await f.pool.query('SELECT role FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
            bot.id,
            member.id,
          ])
        ).rows,
      ).toHaveLength(0);
      let calls = 0;
      await f
        .worker(async (input) => {
          calls++;
          expect(input.modelId).toBe('original-shared-model');
          expect(input.apiKey).toBe('shared-secret');
          expect(input.messages[0]).toEqual({
            role: 'system',
            content: 'Original immutable instructions.',
          });
          throw new Error('retry failed');
        })
        .runOnce();
      expect(calls).toBe(1);
      await grants.remove(f.owner.user.id, f.owner.workspace.id, group.id, grant.id, {
        idempotencyKey: 'close-original',
      });
      const freshGrant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
        botId: bot.id,
        idempotencyKey: 'reinvite-same-bot',
      });
      expect(freshGrant.id).not.toBe(grant.id);
      for (const command of [
        payload,
        { idempotencyKey: 'retry-closed-grant', expectedRunId: retried.json().receipt.runId },
      ]) {
        const forbidden = await app.inject({
          method: 'POST',
          url: url + '/retries',
          headers: member.headers,
          payload: command,
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: { code: 'task_forbidden' } });
      }
      const history = await app.inject({
        url: url + '/runs?cursor=' + retried.json().task.olderRunsCursor,
        headers: member.headers,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({
        runs: [{ id: task.runs[0]!.id, attempt: 1, status: 'failed' }],
        nextCursor: null,
      });
      expect(
        (await f.pool.query('SELECT id FROM task_retry_commands WHERE task_id=$1', [task.id])).rows,
      ).toHaveLength(1);
    },
  );

  it('accepts actual retry and retained history responses through the strict Web client', async () => {
    const { TaskApiClient } = await import('../../../web/src/lib/server/task-api.js');
    const f = await fixture(),
      app = taskApp(f);
    await f
      .worker(async () => {
        throw new Error('private diagnostic');
      })
      .runOnce();
    const request: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      const response = await app.inject({
        method: init?.method === 'POST' ? 'POST' : 'GET',
        url: target.pathname + target.search,
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new TaskApiClient(request, 'http://api', 'http://localhost:3000');
    const session = f.headers.cookie.slice('openbot_session='.length);
    const command = { idempotencyKey: 'actual-bff-retry', expectedRunId: f.task.runs[0]!.id };
    const result = await client.retry(
      session,
      f.owner.workspace.id,
      f.conversation.id,
      f.task.id,
      command,
    );
    expect(result).toMatchObject({
      status: 'available',
      value: { task: { runCount: 2, status: 'queued' }, receipt: { attempt: 2 } },
    });
    if (result.status !== 'available') throw new Error('expected_committed_retry');
    await f
      .worker(async () => ({
        events: [
          { type: 'text', text: 'Retried answer.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: 'private',
      }))
      .runOnce();
    const completed = await client.retry(
      session,
      f.owner.workspace.id,
      f.conversation.id,
      f.task.id,
      command,
    );
    expect(completed).toMatchObject({
      status: 'available',
      value: {
        task: {
          runCount: 2,
          status: 'completed',
          runs: [{ output: { sequence: expect.any(Number) } }],
        },
        receipt: result.value.receipt,
      },
    });
    await f.providers.disable(f.owner.user.id, f.model.id);
    expect(
      await client.retry(session, f.owner.workspace.id, f.conversation.id, f.task.id, command),
    ).toEqual({ status: 'model-unavailable' });
    const history = await client.runs(session, f.owner.workspace.id, f.conversation.id, f.task.id, {
      cursor: result.value.task.olderRunsCursor!,
    });
    expect(history).toMatchObject({
      status: 'available',
      value: {
        nextCursor: null,
        runs: [
          {
            id: command.expectedRunId,
            attempt: 1,
            status: 'failed',
            error: 'provider_failed',
            provider: { modelId: 'test-model' },
          },
        ],
      },
    });
    expect(JSON.stringify(history)).not.toMatch(/private|secret|claim|connectionRevision/u);
  });

  it('rejects new retries in queued/running states and preserves the first receipt across later commands', async () => {
    const f = await fixture(),
      app = taskApp(f);
    const url = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}/retries`;
    const initial = { idempotencyKey: 'first-retry', expectedRunId: f.task.runs[0]!.id };
    const post = (payload = initial) =>
      app.inject({ method: 'POST', url, headers: f.headers, payload });
    for (const expectedState of ['queued', 'running']) {
      const assert = async () => {
        expect((await f.read()).status).toBe(expectedState);
        const response = await post();
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: { code: 'task_retry_state_conflict' } });
      };
      if (expectedState === 'queued') await assert();
      else
        await f
          .worker(async () => {
            await assert();
            throw new Error('provider failed');
          })
          .runOnce();
    }
    const first = (await post()).json();
    await f
      .worker(async () => {
        throw new Error('provider failed again');
      })
      .runOnce();
    const changed = await post({ ...initial, expectedRunId: first.receipt.runId });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: { code: 'idempotency_conflict' } });
    const stale = await post({ ...initial, idempotencyKey: 'stale-run' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: { code: 'task_retry_run_conflict' } });
    const second = await post({
      idempotencyKey: 'second-retry',
      expectedRunId: first.receipt.runId,
    });
    expect(second.statusCode).toBe(202);
    const replay = await post();
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({
      receipt: first.receipt,
      task: {
        runCount: 3,
        status: 'queued',
        runs: [{ id: second.json().receipt.runId, attempt: 3 }],
      },
    });
    expect((await f.pool.query('SELECT id FROM task_retry_commands')).rows).toHaveLength(2);
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(3);
    const audits = (
      await f.pool.query(
        "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='task.retried' ORDER BY occurred_at",
      )
    ).rows;
    expect(audits).toHaveLength(2);
    expect(
      audits.map(({ actor_user_id, metadata }) => ({
        actor: actor_user_id,
        taskId: metadata.taskId,
        previousRunId: metadata.previousRunId,
        runId: metadata.runId,
        attempt: metadata.attempt,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          actor: f.owner.user.id,
          taskId: f.task.id,
          previousRunId: initial.expectedRunId,
          runId: first.receipt.runId,
          attempt: 2,
        },
        {
          actor: f.owner.user.id,
          taskId: f.task.id,
          previousRunId: first.receipt.runId,
          runId: second.json().receipt.runId,
          attempt: 3,
        },
      ]),
    );
  });

  it('rejects forged commands and history scopes without creating an attempt or clearing another user identity', async () => {
    const f = await fixture(),
      app = taskApp(f),
      outsider = await f.addUser('administrator');
    await f
      .worker(async () => {
        throw new Error('failed');
      })
      .runOnce();
    const base = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}`;
    const payload = { idempotencyKey: 'validated-retry', expectedRunId: f.task.runs[0]!.id };
    for (const invalid of [
      { ...payload, actorUserId: outsider.id },
      { ...payload, body: 'edited prompt' },
      { ...payload, groupGrantId: f.bot.id },
      { ...payload, expectedRunId: 'invalid' },
      { ...payload, idempotencyKey: 'with space' },
      { idempotencyKey: 'missing-run' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: base + '/retries',
        headers: f.headers,
        payload: invalid,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: 'invalid_task_request' } });
    }
    const forbidden = await app.inject({
      method: 'POST',
      url: base + '/retries',
      headers: outsider.headers,
      payload,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: { code: 'task_forbidden' } });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base + '/retries',
          headers: { ...f.headers, origin: 'https://elsewhere.example' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const cursor = {
      v: 1 as const,
      conversationId: f.conversation.id,
      taskId: f.task.id,
      horizon: 1,
      before: 2,
    };
    for (const query of [
      'limit=51',
      'limit=1&limit=2',
      'messageId=' + payload.expectedRunId,
      'cursor=invalid',
      'cursor=a&cursor=b',
      ...[
        { ...cursor, conversationId: f.bot.id },
        { ...cursor, taskId: f.bot.id },
        { ...cursor, horizon: 2, before: 3 },
        { ...cursor, before: 0 },
      ].map((value) => 'cursor=' + encodeRunHistoryCursor(value)),
    ]) {
      const response = await app.inject({ url: base + '/runs?' + query, headers: f.headers });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: 'invalid_task_request' } });
    }
    expect((await app.inject({ url: base + '/runs', headers: outsider.headers })).statusCode).toBe(
      403,
    );
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(1);
    expect((await f.pool.query('SELECT id FROM task_retry_commands')).rows).toHaveLength(0);
  });

  it('keeps current reads bounded and pages every older immutable attempt without provider-use permission', async () => {
    const f = await fixture();
    const queue = new TaskQueue(f.pool);
    for (let attempt = 1; attempt <= 22; attempt++) {
      const claim = (await queue.claimNext()).claim!;
      await queue.finish(claim, {
        error: 'provider_failed',
        usage: { inputTokens: attempt, outputTokens: 0 },
      });
      if (attempt < 22)
        await f.tasks.retry(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id, {
          idempotencyKey: `retry-${attempt}`,
          expectedRunId: claim.runId,
        });
    }
    const current = await f.read();
    expect(current.runs).toHaveLength(1);
    expect(current.runCount).toBe(22);
    const olderCursor = current.olderRunsCursor!;
    await f.tasks.retry(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id, {
      idempotencyKey: 'retry-after-history-cursor',
      expectedRunId: current.runs[0]!.id,
    });
    await f.providers.disable(f.owner.user.id, f.model.id);
    const app = buildApp({
      auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
      tasks: f.tasks,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const url = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}/runs`;
    const first = await app.inject({ url: `${url}?cursor=${olderCursor}`, headers: f.headers });
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(page).toMatchObject({
      conversationId: f.conversation.id,
      taskId: f.task.id,
      nextCursor: expect.any(String),
    });
    expect(page.runs).toHaveLength(20);
    expect(page.runs.map((run: { attempt: number }) => run.attempt)).toEqual(
      Array.from({ length: 20 }, (_, index) => 21 - index),
    );
    const second = await app.inject({
      url: `${url}?cursor=${page.nextCursor}&limit=50`,
      headers: f.headers,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      runs: [{ attempt: 1, status: 'failed', usage: { inputTokens: 1, outputTokens: 0 } }],
      nextCursor: null,
    });
    expect(second.json().runs).toHaveLength(1);
    expect((await f.read()).runCount).toBe(23);
    expect(first.headers['cache-control']).toBe('private, no-store');
  }, 30000);

  it('completes the new attempt with fresh credentials while retaining the failed attempt and fencing its old claim', async () => {
    const f = await fixture();
    const queue = new TaskQueue(f.pool);
    const oldClaim = (await queue.claimNext()).claim!;
    await queue.finish(oldClaim, {
      error: 'provider_failed',
      usage: { inputTokens: 9, outputTokens: 2 },
    });
    const originalRun = (
      await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [oldClaim.runId])
    ).rows[0];
    await f.providers.update(f.owner.user.id, f.model.id, { apiKey: 'rotated-retry-secret' });
    const command = {
      idempotencyKey: 'retry-with-rotated-credential',
      expectedRunId: oldClaim.runId,
    };
    const retried = await f.tasks.retry(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      f.task.id,
      command,
    );
    let calls = 0;
    await f
      .worker(async (input) => {
        calls++;
        expect(input.apiKey).toBe('rotated-retry-secret');
        expect(input.modelId).toBe('test-model');
        expect(await queue.finish(oldClaim, { body: 'Late old output.', usage: null })).toBe(false);
        expect((await f.read()).status).toBe('running');
        return {
          events: [
            { type: 'text', text: 'Current retry answer.' },
            { type: 'usage', inputTokens: 3, outputTokens: 5 },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        };
      })
      .runOnce();
    expect(calls).toBe(1);
    const current = await f.read();
    expect(current).toMatchObject({
      status: 'completed',
      runCount: 2,
      runs: [
        {
          id: retried.receipt.runId,
          attempt: 2,
          status: 'completed',
          usage: { inputTokens: 3, outputTokens: 5 },
        },
      ],
    });
    expect(
      (await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [oldClaim.runId])).rows[0],
    ).toEqual(originalRun);
    const newRun = (
      await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [retried.receipt.runId])
    ).rows[0];
    expect(newRun.connection_revision).toBe(originalRun.connection_revision + 1);
    const audits = (
      await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='task.running'")
    ).rows;
    expect(audits).toHaveLength(2);
    expect(
      audits.map(({ metadata }) => ({ runId: metadata.runId, attempt: metadata.attempt })),
    ).toEqual(
      expect.arrayContaining([
        { runId: oldClaim.runId, attempt: 1 },
        { runId: retried.receipt.runId, attempt: 2 },
      ]),
    );
    expect(
      (
        await f.pool.query(
          "SELECT body FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toEqual([{ body: 'Current retry answer.' }]);
    expect(
      await f.tasks.retry(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        f.task.id,
        command,
      ),
    ).toEqual({ task: current, receipt: retried.receipt });
    await expect(
      f.tasks.retry(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id, {
        ...command,
        idempotencyKey: 'new-completed-retry',
        expectedRunId: retried.receipt.runId,
      }),
    ).rejects.toMatchObject({ code: 'task_retry_state_conflict' });
  });

  it('creates and replays one next queued Run on the same failed Task without another trigger', async () => {
    const f = await fixture();
    await f
      .worker(async () => {
        throw new Error('Private failed-provider diagnostic');
      })
      .runOnce();
    const failed = await f.read();
    expect(failed.status).toBe('failed');
    const originalRun = (
      await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [failed.runs[0]!.id])
    ).rows[0];
    const app = buildApp({
      auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
      tasks: f.tasks,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const request = {
      method: 'POST' as const,
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}/retries`,
      headers: f.headers,
      payload: { idempotencyKey: 'retry-first-failure', expectedRunId: failed.runs[0]!.id },
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      task: {
        id: f.task.id,
        status: 'queued',
        runCount: 2,
        olderRunsCursor: expect.any(String),
        trigger: failed.trigger,
        runs: [{ attempt: 2, status: 'queued', provider: null, error: null }],
      },
      receipt: { runId: expect.any(String), attempt: 2 },
    });
    expect(first.json().task.runs).toHaveLength(1);
    expect(first.json().receipt.runId).toBe(first.json().task.runs[0].id);
    expect((await app.inject(request)).json()).toEqual(first.json());
    const queuedDelivery = (
      await f.pool.query(
        "SELECT sequence,execution FROM conversation_delivery_events WHERE run_id=$1 AND run_status='queued'",
        [first.json().receipt.runId],
      )
    ).rows;
    expect(queuedDelivery).toHaveLength(1);
    expect(queuedDelivery[0].execution).toMatchObject({
      taskId: f.task.id,
      runId: first.json().receipt.runId,
      attempt: 2,
      taskStatus: 'queued',
      runStatus: 'queued',
    });
    expect(
      (
        await f.pool.query(
          "SELECT sequence FROM task_run_delivery_receipts WHERE run_id=$1 AND run_status='queued'",
          [first.json().receipt.runId],
        )
      ).rows,
    ).toEqual([{ sequence: queuedDelivery[0].sequence }]);
    expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(2);
    expect(
      (await f.pool.query("SELECT id FROM conversation_events WHERE event_type='message.created'"))
        .rows,
    ).toHaveLength(1);
    expect(
      (await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [originalRun.id])).rows[0],
    ).toEqual(originalRun);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.body).not.toMatch(/Private failed-provider|sealed|claim_token|connectionId/u);
  });
});

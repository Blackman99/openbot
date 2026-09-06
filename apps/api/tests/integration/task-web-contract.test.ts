import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { BotLifecycleService } from '../../src/bots/lifecycle-service.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import type { ModelEvent } from '../../src/providers/model-events.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';

describe('Task Web client and actual HTTP/domain contract', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  // The completed path seeds 30 messages and checks the worker through real HTTP services.
  it.each(['completed', 'failed'] as const)(
    'submits and reloads a %s attempt through the strict BFF, including retained archived history',
    async (outcome) => {
      const { TaskApiClient } = await import('../../../web/src/lib/server/task-api.js');
      const { ConversationApiClient } =
        await import('../../../web/src/lib/server/conversation-api.js');
      const f = await botAclFixture(cleanup);
      const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
      const conversation = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
        subject: { kind: 'direct-bot', id: f.bot.id },
      });
      if (outcome === 'completed')
        for (let index = 0; index < 30; index++)
          await conversations.append(f.owner.user.id, f.owner.workspace.id, conversation.id, {
            idempotencyKey: `earlier-${index}`,
            body: `Earlier message ${index}`,
          });
      const app = buildApp({
        auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
        conversations,
        tasks: new TaskService(f.pool),
        readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
      });
      cleanup.push(() => app.close());
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
      const session = f.headers.cookie.slice('openbot_session='.length),
        workspaceId = f.owner.workspace.id;
      const client = new TaskApiClient(request, 'http://api', 'http://localhost:3000');
      const command = {
        idempotencyKey: 'web-task-contract',
        body: 'Compare\n  the actual evidence.',
      };
      const submitted = await client.submit(session, workspaceId, conversation.id, command);
      expect(submitted).toMatchObject({
        status: 'available',
        value: {
          status: 'queued',
          bot: { id: f.bot.id },
          executionUser: { id: f.owner.user.id },
          tokenBudgets: [
            {
              kind: 'run',
              used: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              reserved: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              remaining: { totalTokens: 32768 },
            },
          ],
          runs: [{ status: 'queued' }],
        },
      });
      if (submitted.status !== 'available') throw new Error('expected_saved_task');
      expect(await client.submit(session, workspaceId, conversation.id, command)).toEqual(
        submitted,
      );
      const worker = new TaskWorker(f.pool, {
        secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
        createAdapter: () => ({
          generate: async (_input, _signal, onEvent) => {
            const events: ModelEvent[] = [
              { type: 'text', text: 'The completed response.' },
              { type: 'usage', inputTokens: 12, outputTokens: 0 },
              { type: 'complete', stopReason: 'stop' },
            ];
            for (const event of events) await onEvent?.(event);
            if (outcome === 'failed') throw new Error('private provider diagnostic after complete');
            return { events, raw: 'private provider response' };
          },
        }),
      });
      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(false);
      await new BotLifecycleService(f.pool).archive(f.owner.user.id, workspaceId, f.bot.id);
      const reloaded = await new TaskApiClient(request, 'http://api', 'http://localhost:3000').get(
        session,
        workspaceId,
        conversation.id,
        submitted.value.id,
      );
      expect(reloaded).toMatchObject({
        status: 'available',
        value: {
          id: submitted.value.id,
          status: outcome,
          tokenBudgets: [
            {
              kind: 'run',
              used: { inputTokens: 12, outputTokens: 0, totalTokens: 12 },
              reserved: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              remaining: { totalTokens: 32756 },
            },
          ],
          runs: [
            {
              status: outcome,
              provider: { protocol: 'openai-chat', modelId: 'test-model' },
              usage: { inputTokens: 12, outputTokens: 0, estimated: false },
              error: outcome === 'failed' ? 'provider_failed' : null,
            },
          ],
        },
      });
      if (reloaded.status !== 'available') throw new Error('expected_persisted_task');
      expect(await client.list(session, workspaceId, conversation.id)).toEqual({
        status: 'available',
        value: { conversationId: conversation.id, tasks: [reloaded.value], nextCursor: null },
      });
      const history = await new ConversationApiClient(
        request,
        'http://api',
        'http://localhost:3000',
      ).get(session, workspaceId, conversation.id);
      expect(history).toMatchObject({
        status: 'available',
        value: { canWrite: false, conversation: { botLifecycleState: 'archived' } },
      });
      if (history.status !== 'available') throw new Error('expected_retained_history');
      expect(history.value.messages).toHaveLength(outcome === 'completed' ? 30 : 1);
      if (outcome === 'completed') {
        const output = reloaded.value.runs[0]!.output!;
        expect(history.value.messages.some(({ id }) => id === output.messageId)).toBe(false);
        const located = await new ConversationApiClient(
          request,
          'http://api',
          'http://localhost:3000',
        ).get(session, workspaceId, conversation.id, {
          messageId: output.messageId.toUpperCase(),
          limit: 1,
        });
        expect(located).toMatchObject({
          status: 'available',
          value: { canWrite: false, nextCursor: null, messages: [{ id: output.messageId }] },
        });
        if (located.status !== 'available') throw new Error('expected_located_response');
        expect(located.value.messages).toHaveLength(1);
        expect(located.value.messages[0]).toMatchObject({
          body: 'The completed response.',
          author: {
            kind: 'bot',
            id: f.bot.id,
            versionId: f.bot.currentVersion.id,
            versionNumber: 1,
          },
          canEdit: false,
          canDelete: false,
          canAudit: false,
        });
        const url = `/api/v1/workspaces/${workspaceId}/conversations/${conversation.id}`;
        for (const query of [
          `messageId=${output.messageId}&cursor=opaque_cursor`,
          'messageId=invalid',
          `messageId=${output.messageId}&messageId=${output.messageId}`,
        ])
          expect(
            (await app.inject({ method: 'GET', url: `${url}?${query}`, headers: f.headers }))
              .statusCode,
          ).toBe(400);
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `${url}?messageId=${f.bot.id}`,
              headers: f.headers,
            })
          ).statusCode,
        ).toBe(403);
        const outsider = await f.addUser();
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `${url}?messageId=${output.messageId}`,
              headers: outsider.headers,
            })
          ).statusCode,
        ).toBe(403);
        const group = await new GroupService(new PostgresGroupRepository(f.pool)).create(
          f.owner.user.id,
          workspaceId,
          { name: 'Another conversation' },
        );
        const otherConversation = await conversations.open(f.owner.user.id, workspaceId, {
          subject: { kind: 'group', id: group.id },
        });
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/api/v1/workspaces/${workspaceId}/conversations/${otherConversation.id}?messageId=${output.messageId}`,
              headers: f.headers,
            })
          ).statusCode,
        ).toBe(403);
      } else {
        expect(history.value.messages[0]?.body).toBe(command.body);
        expect(reloaded.value.runs[0]?.output).toBeNull();
      }
      expect(JSON.stringify(reloaded)).not.toMatch(
        /never-return-provider-secret|private provider|Instructions visible|sealed|claimToken/u,
      );
    },
    15_000,
  );
});

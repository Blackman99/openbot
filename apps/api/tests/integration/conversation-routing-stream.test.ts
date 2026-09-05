import { afterEach, expect, it } from 'vitest';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupRoutingService } from '../../src/routing/service.js';
import { TaskInputError, TaskService } from '../../src/tasks/service.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { ConversationStreamService } from '../../src/conversations/stream-service.js';
import { encodeConversationStreamCursor } from '../../src/conversations/stream-protocol.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const summary = { algorithm: 'local-terms-v1', reason: 'local-match' };
const frameValue = (frame: string) => JSON.parse(frame.match(/^data: (.+)$/mu)![1]!);

it('retains the original small routing summary through queued delivery, resume, bootstrap and a later retry', async () => {
  const f = await botAclFixture(cleanup);
  const group = await new GroupService(new PostgresGroupRepository(f.pool)).create(
    f.owner.user.id,
    f.owner.workspace.id,
    { name: 'Routed stream' },
  );
  const grant = await new GroupBotService(new PostgresGroupBotRepository(f.pool)).invite(
    f.owner.user.id,
    f.owner.workspace.id,
    group.id,
    { botId: f.bot.id, idempotencyKey: 'routing-stream-grant' },
  );
  const tasks = new TaskService(f.pool);
  const scope = { workspaceId: f.owner.workspace.id, conversationId: grant.conversationId };
  const task = await tasks.submit(f.owner.user.id, scope.workspaceId, scope.conversationId, {
    idempotencyKey: 'routing-stream-task',
    body: 'Research discovery',
  });
  const token = f.headers.cookie.split('=')[1]!;
  const stream = new ConversationStreamService(f.pool);
  const initial = await stream.bootstrap(token, scope);
  expect(initial.executions).toEqual([
    expect.objectContaining({
      taskId: task.id,
      runId: task.runs[0]!.id,
      attempt: 1,
      runStatus: 'queued',
      routing: summary,
    }),
  ]);
  const stored = (
    await f.pool.query(
      "SELECT execution FROM conversation_delivery_events WHERE run_id=$1 AND run_status='queued'",
      [task.runs[0]!.id],
    )
  ).rows;
  expect(stored).toHaveLength(1);
  expect(stored[0].execution.routing).toEqual(summary);
  const frames: string[] = [];
  const beforeQueued = encodeConversationStreamCursor(scope, task.trigger.sequence);
  await stream.deliver(token, scope, beforeQueued, (frame) => frames.push(frame));
  const first = frameValue(frames[0]!);
  expect(first.data.execution.routing).toEqual(summary);
  expect(first.cursor).toBe(initial.cursor);
  const restarted = new ConversationStreamService(f.pool);
  await restarted.deliver(token, scope, beforeQueued, (frame) => expect(frame).toBe(frames[0]));

  const queue = new TaskQueue(f.pool);
  const selected = await queue.claimNext();
  expect(selected.claim?.runId).toBe(task.runs[0]!.id);
  await queue.finish(selected.claim!, { error: 'provider_failed', usage: null });
  await new GroupRoutingService(f.pool).update(f.owner.user.id, scope.workspaceId, group.id, {
    expectedRevision: 0,
    defaultGrantId: grant.id,
  });
  const retry = await tasks.retry(
    f.owner.user.id,
    scope.workspaceId,
    scope.conversationId,
    task.id,
    { idempotencyKey: 'routing-stream-retry', expectedRunId: task.runs[0]!.id },
  );
  const current = await restarted.bootstrap(token, scope);
  expect(current.executions).toEqual([
    expect.objectContaining({
      taskId: task.id,
      runId: retry.receipt.runId,
      attempt: 2,
      runStatus: 'queued',
      routing: summary,
    }),
  ]);
  let cursor = initial.cursor;
  const resumed: Array<[number, string]> = [];
  for (let index = 0; index < 3; index++) {
    const next = await restarted.deliver(token, scope, cursor, (frame) => {
      const event = frameValue(frame);
      expect(event.data.execution.routing).toEqual(summary);
      resumed.push([event.data.execution.attempt, event.data.execution.runStatus]);
      frames.push(frame);
    });
    expect(next.delivered).toBe(true);
    cursor = next.cursor;
  }
  expect(resumed).toEqual([
    [1, 'running'],
    [1, 'failed'],
    [2, 'queued'],
  ]);
  expect(cursor).toBe(current.cursor);
  expect(
    await restarted.deliver(token, scope, cursor, () => {
      throw new Error('duplicate');
    }),
  ).toEqual({ cursor, delivered: false });
  expect(JSON.stringify([initial, current, frames])).not.toMatch(
    /candidates|matchedTerms|modelBinding|instructions|never-return/iu,
  );
  expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
});

it('keeps direct execution wire-compatible without routing and rejects caller-supplied routing', async () => {
  const f = await botAclFixture(cleanup);
  const conversation = await new ConversationService(
    new PostgresConversationRepository(f.pool),
  ).open(f.owner.user.id, f.owner.workspace.id, { subject: { kind: 'direct-bot', id: f.bot.id } });
  const tasks = new TaskService(f.pool);
  const scope = { workspaceId: f.owner.workspace.id, conversationId: conversation.id };
  await tasks.submit(f.owner.user.id, scope.workspaceId, scope.conversationId, {
    idempotencyKey: 'direct-stream',
    body: 'Direct request',
  });
  expect(() =>
    tasks.submit(f.owner.user.id, scope.workspaceId, scope.conversationId, {
      idempotencyKey: 'forged-stream',
      body: 'Forged request',
      routing: summary,
    }),
  ).toThrow(TaskInputError);
  const snapshot = await new ConversationStreamService(f.pool).bootstrap(
    f.headers.cookie.split('=')[1]!,
    scope,
  );
  expect(snapshot.executions).toHaveLength(1);
  expect(snapshot.executions[0]).not.toHaveProperty('routing');
  expect((await f.pool.query('SELECT task_id FROM task_routing_decisions')).rows).toHaveLength(0);
});

import { afterEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import { CLAIM_LEASE_MS } from '../../src/tasks/lease.js';
import { taskFixture } from '../helpers/task-fixture.js';
import { createQueuedTaskChild } from '../helpers/task-tree-fixture.js';

describe('COL-13 claim concurrency holds', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function groupFixture(now: () => Date = () => new Date()) {
    const f = await taskFixture(cleanup, now);
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Concurrency group',
    });
    const shared = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
      name: 'Shared concurrency',
      baseUrl: 'https://models.example/v1',
      modelId: 'shared-model',
      apiKey: 'shared-concurrency-secret',
      headers: {},
    });
    const sharedBot = await new BotService(new PostgresBotRepository(f.pool)).create(
      f.owner.user.id,
      f.owner.workspace.id,
      {
        name: 'Shared helper',
        roleDescription: 'Assistant',
        instructions: 'Private concurrency instructions',
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
      idempotencyKey: 'concurrency-invite',
    });
    const queue = new TaskQueue(f.pool, now);
    const drained = await queue.claimNext();
    expect(drained.claim?.taskId).toBe(f.task.id);
    expect(await queue.finish(drained.claim!, { body: 'Direct drain.', usage: null })).toBe(true);
    return { ...f, groups, group, grants, grant, sharedBot, queue };
  }

  async function submitGroup(
    f: Awaited<ReturnType<typeof groupFixture>>,
    count: number,
    prefix: string,
    grant = f.grant,
  ) {
    const tasks = [];
    for (let index = 0; index < count; index++)
      tasks.push(
        await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, grant.conversationId, {
          idempotencyKey: `${prefix}-${index}`,
          body: `${prefix} ${index}`,
          groupGrantId: grant.id,
        }),
      );
    return tasks;
  }

  async function readTask(
    f: Awaited<ReturnType<typeof groupFixture>>,
    conversationId: string,
    taskId: string,
  ) {
    return f.tasks.get(f.owner.user.id, f.owner.workspace.id, conversationId, taskId);
  }

  it('keeps a fifth default-group Run queued with the blocking layer and releases on finish or failure', async () => {
    const f = await groupFixture();
    const tasks = await submitGroup(f, 6, 'group-cap');
    const claimed = [];
    for (let index = 0; index < 4; index++) {
      const next = await f.queue.claimNext();
      expect(next.claim?.taskId).toBe(tasks[index]!.id);
      claimed.push(next.claim!);
    }
    expect(await f.queue.claimNext()).toEqual({ handled: false });
    const held = await readTask(f, f.grant.conversationId, tasks[4]!.id);
    expect(held).toMatchObject({
      status: 'queued',
      runs: [
        {
          status: 'queued',
          queueHold: { reason: 'concurrency', layer: 'group', limit: 4, used: 4 },
        },
      ],
    });
    expect(held.status).not.toBe('waiting_budget');
    expect(
      (
        await f.pool.query('SELECT layer FROM task_run_concurrency_holds WHERE run_id=$1', [
          tasks[4]!.runs[0]!.id,
        ])
      ).rows,
    ).toEqual([{ layer: 'group' }]);

    expect(await f.queue.finish(claimed[0]!, { body: 'First finished.', usage: null })).toBe(true);
    const afterComplete = await f.queue.claimNext();
    expect(afterComplete.claim?.taskId).toBe(tasks[4]!.id);
    expect((await readTask(f, f.grant.conversationId, tasks[4]!.id)).runs[0]).not.toHaveProperty(
      'queueHold',
    );

    expect(await f.queue.claimNext()).toEqual({ handled: false });
    expect(await readTask(f, f.grant.conversationId, tasks[5]!.id)).toMatchObject({
      status: 'queued',
      runs: [{ queueHold: { reason: 'concurrency', layer: 'group', limit: 4, used: 4 } }],
    });
    expect(await f.queue.finish(claimed[1]!, { error: 'provider_failed', usage: null })).toBe(true);
    expect((await f.queue.claimNext()).claim?.taskId).toBe(tasks[5]!.id);
  });

  it('skips a blocked group candidate so a later due Run in another group can claim', async () => {
    const f = await groupFixture();
    const other = await f.groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Other concurrency group',
    });
    const otherGrant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, other.id, {
      botId: f.sharedBot.id,
      idempotencyKey: 'other-concurrency-invite',
    });
    const blocked = await submitGroup(f, 5, 'full-group');
    const later = await submitGroup(f, 1, 'other-group', otherGrant);
    for (let index = 0; index < 4; index++)
      expect((await f.queue.claimNext()).claim?.taskId).toBe(blocked[index]!.id);
    expect((await f.queue.claimNext()).claim?.taskId).toBe(later[0]!.id);
    expect(await readTask(f, f.grant.conversationId, blocked[4]!.id)).toMatchObject({
      status: 'queued',
      runs: [{ queueHold: { reason: 'concurrency', layer: 'group', limit: 4, used: 4 } }],
    });
  });

  it('does not occupy a slot after the worker lease expires', async () => {
    let now = new Date('2026-09-06T04:00:00.000Z');
    const f = await groupFixture(() => now);
    const tasks = await submitGroup(f, 5, 'expired-lease');
    const claimed = new Set<string>();
    for (let index = 0; index < 4; index++) {
      const next = await f.queue.claimNext();
      expect(next.claim).toBeTruthy();
      claimed.add(next.claim!.taskId);
    }
    expect(await f.queue.claimNext()).toEqual({ handled: false });
    const held = tasks.find((task) => !claimed.has(task.id))!;
    now = new Date(now.getTime() + CLAIM_LEASE_MS + 1);
    expect((await f.queue.claimNext()).claim?.taskId).toBe(held.id);
    expect(await readTask(f, f.grant.conversationId, [...claimed][0]!)).toMatchObject({
      status: 'running',
    });
  });

  it('applies a parent Task child cap independently of the default group cap', async () => {
    const f = await groupFixture();
    const parent = (await submitGroup(f, 1, 'parent-cap'))[0]!;
    expect((await f.queue.claimNext()).claim?.taskId).toBe(parent.id);
    await f.pool.query('UPDATE tasks SET execution_policy=$2::jsonb WHERE id=$1', [
      parent.id,
      JSON.stringify({ maxConcurrentRuns: 1 }),
    ]);
    const input = {
      workspaceId: f.owner.workspace.id,
      conversationId: f.grant.conversationId,
      executionUserId: f.owner.user.id,
      botId: parent.bot.id,
      botVersionId: parent.bot.versionId,
      groupGrantId: f.grant.id,
      parentTaskId: parent.id,
    };
    const first = await createQueuedTaskChild(f.pool, input);
    const second = await createQueuedTaskChild(f.pool, input);
    expect((await f.queue.claimNext()).claim?.taskId).toBe(first.id);
    expect(await f.queue.claimNext()).toEqual({ handled: false });
    expect(await readTask(f, f.grant.conversationId, second.id)).toMatchObject({
      status: 'queued',
      runs: [
        {
          status: 'queued',
          queueHold: { reason: 'concurrency', layer: 'task', limit: 1, used: 1 },
        },
      ],
    });
    expect(
      (await f.pool.query('SELECT status FROM task_runs WHERE task_id=$1', [parent.id])).rows,
    ).toEqual([{ status: 'running' }]);
  });

  it('does not apply the default group cap to a direct conversation', async () => {
    const f = await groupFixture();
    const direct = [];
    for (let index = 0; index < 5; index++)
      direct.push(
        await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
          idempotencyKey: `direct-${index}`,
          body: `Direct ${index}`,
        }),
      );
    for (const task of direct) expect((await f.queue.claimNext()).claim?.taskId).toBe(task.id);
    expect(await f.queue.claimNext()).toEqual({ handled: false });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { taskFixture } from '../helpers/task-fixture.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-repository.js';
import { ExecutionLimitService } from '../../src/tasks/limit-policy.js';
import { TaskService } from '../../src/tasks/service.js';
import { parseTask } from '../../../web/src/lib/server/task-contract.js';

describe('COL-12 hierarchical execution limits', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function drainSeed(f: Awaited<ReturnType<typeof taskFixture>>) {
    await f
      .worker(async () => ({
        events: [
          { type: 'text', text: 'Seed complete.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      }))
      .runOnce();
    return f;
  }

  async function personal() {
    const f = await drainSeed(await taskFixture(cleanup));
    const limits = new ExecutionLimitService(f.pool);
    const app = buildApp({
      auth: f.auth,
      tasks: f.tasks,
      executionLimits: limits,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    return { ...f, limits, app };
  }

  async function grouped() {
    const f = await taskFixture(cleanup);
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Limit group',
    });
    const provider = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
      name: 'Shared limit model',
      baseUrl: 'https://models.example/v1',
      modelId: 'shared-model',
      apiKey: 'limit-provider-secret',
      headers: {},
    });
    const bot = await new BotService(new PostgresBotRepository(f.pool)).create(
      f.owner.user.id,
      f.owner.workspace.id,
      {
        name: 'Shared limiter',
        roleDescription: 'Assistant',
        instructions: 'Honor the published limits.',
        modelBinding: {
          scope: { kind: 'workspace', id: f.owner.workspace.id },
          connectionId: provider.id,
          modelId: provider.modelId,
        },
      },
    );
    const grant = await new GroupBotService(new PostgresGroupBotRepository(f.pool)).invite(
      f.owner.user.id,
      f.owner.workspace.id,
      group.id,
      { botId: bot.id, idempotencyKey: 'limit-invite' },
    );
    const limits = new ExecutionLimitService(f.pool);
    return { ...f, groups, group, grant, sharedBot: bot, limits };
  }

  it('snapshots the strictest Workspace, Group, Task, and Run sources on submit', async () => {
    const f = await grouped();
    await f.limits.putWorkspacePolicy(f.owner.user.id, f.owner.workspace.id, {
      maxDurationSeconds: 60,
      maxTurns: 4,
      maxHandoffs: 2,
    });
    await f.limits.putGroupPolicy(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      maxDurationSeconds: 120,
      maxTurns: 3,
      maxDelegationDepth: 1,
    });
    const task = await f.tasks.submit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.grant.conversationId,
      {
        idempotencyKey: 'layered-limits',
        body: 'Honor every layer.',
        groupGrantId: f.grant.id,
        policy: { maxTurns: 6 },
      },
    );
    expect(task.limits).toMatchObject({
      durationMs: 60_000,
      durationSource: 'workspace',
      turns: 3,
      turnsSource: 'group',
      depth: 1,
      depthSource: 'group',
      handoffs: 2,
      handoffsSource: 'workspace',
      usage: { durationMs: 0, turns: 0, depth: 0, handoffs: 0 },
      warnings: [],
    });
    const stored = (
      await f.pool.query(
        `SELECT max_duration_ms,duration_source,max_turns,turns_source,max_delegation_depth,delegation_depth_source,max_handoffs,handoffs_source
         FROM task_execution_limit_snapshots WHERE task_id=$1`,
        [task.id],
      )
    ).rows[0]!;
    expect({
      max_duration_ms: Number(stored.max_duration_ms),
      duration_source: stored.duration_source,
      max_turns: Number(stored.max_turns),
      turns_source: stored.turns_source,
      max_delegation_depth: Number(stored.max_delegation_depth),
      delegation_depth_source: stored.delegation_depth_source,
      max_handoffs: Number(stored.max_handoffs),
      handoffs_source: stored.handoffs_source,
    }).toEqual({
      max_duration_ms: 60_000,
      duration_source: 'workspace',
      max_turns: 3,
      turns_source: 'group',
      max_delegation_depth: 1,
      delegation_depth_source: 'group',
      max_handoffs: 2,
      handoffs_source: 'workspace',
    });
    expect(parseTask(JSON.parse(JSON.stringify(task)), f.grant.conversationId)).toMatchObject({
      id: task.id,
      limits: { turns: 3, turnsSource: 'group' },
    });
  });

  it('appends one visible soft warning after completing one of two turns', async () => {
    const f = await personal();
    const task = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'soft-turns',
      body: 'Complete the first turn.',
      policy: { maxTurns: 2 },
    });
    expect(
      await f
        .worker(async () => ({
          events: [
            { type: 'text', text: 'First turn.' },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }))
        .runOnce(),
    ).toBe(true);
    const saved = await f.tasks.get(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      task.id,
    );
    expect(saved).toMatchObject({
      status: 'completed',
      limits: {
        turns: 2,
        turnsSource: 'task',
        usage: { turns: 1 },
        warnings: [{ kind: 'soft_warning', dimension: 'turns', usage: 1, threshold: 1 }],
      },
    });
    expect(
      (
        await f.pool.query(
          "SELECT event_type, metadata->>'dimension' AS dimension FROM audit_events WHERE event_type='task.limit.warning'",
        )
      ).rows,
    ).toEqual([{ event_type: 'task.limit.warning', dimension: 'turns' }]);
    expect(
      (await f.pool.query('SELECT kind,dimension,usage,threshold FROM task_limit_events')).rows,
    ).toEqual([{ kind: 'soft_warning', dimension: 'turns', usage: 1, threshold: 1 }]);
  });

  it('holds a turns=0 Task in waiting_budget without starting a provider call', async () => {
    const f = await personal();
    const task = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'hard-turns',
      body: 'Do not start.',
      policy: { maxTurns: 0 },
    });
    let calls = 0;
    expect(
      await f
        .worker(async () => {
          calls += 1;
          throw new Error('must not call provider');
        })
        .runOnce(),
    ).toBe(true);
    expect(calls).toBe(0);
    const held = await f.tasks.get(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      task.id,
    );
    expect(held).toMatchObject({
      status: 'waiting_budget',
      runs: [{ id: task.runs[0]!.id, status: 'waiting_budget', startedAt: null, provider: null }],
      limits: {
        turns: 0,
        turnsSource: 'task',
        warnings: [{ kind: 'hard_limit', dimension: 'turns', usage: 0, threshold: 0 }],
      },
    });
    expect(
      (
        await f.pool.query(
          "SELECT event_type FROM audit_events WHERE event_type='task.limit.held' AND metadata->>'taskId'=$1",
          [task.id],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('grants only the selected limit idempotently and resumes without rewriting usage', async () => {
    const f = await personal();
    const task = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'grant-hold',
      body: 'Wait for budget.',
      policy: { maxTurns: 0 },
    });
    await f
      .worker(async () => {
        throw new Error('must not call provider');
      })
      .runOnce();
    const usageBefore = (
      await f.pool.query('SELECT usage FROM task_limit_events WHERE task_id=$1 AND kind=$2', [
        task.id,
        'hard_limit',
      ])
    ).rows;
    const url = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${task.id}/limit-grants`;
    const command = { idempotencyKey: 'grant-turns', dimension: 'turns', limit: 2 };
    const first = await f.app.inject({
      method: 'POST',
      url,
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: JSON.stringify(command),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      task: { id: task.id, status: 'queued', runCount: 2 },
      grant: {
        taskId: task.id,
        dimension: 'turns',
        previousLimit: 0,
        grantedLimit: 2,
        runId: expect.any(String),
        attempt: 2,
      },
    });
    expect(first.json().task.limits).toMatchObject({
      turns: 2,
      turnsSource: 'task',
      usage: { turns: 0 },
    });
    const replay = await f.app.inject({
      method: 'POST',
      url,
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: JSON.stringify(command),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().grant).toEqual(first.json().grant);
    expect(
      (await f.pool.query('SELECT id FROM task_limit_grants WHERE task_id=$1', [task.id])).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.pool.query('SELECT usage FROM task_limit_events WHERE task_id=$1 AND kind=$2', [
          task.id,
          'hard_limit',
        ])
      ).rows,
    ).toEqual(usageBefore);
    expect(
      await f
        .worker(async () => ({
          events: [
            { type: 'text', text: 'Granted turn.' },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }))
        .runOnce(),
    ).toBe(true);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id),
    ).toMatchObject({
      status: 'completed',
      runCount: 2,
      limits: { turns: 2, usage: { turns: 1 } },
    });
    const conflict = await f.app.inject({
      method: 'POST',
      url,
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...command, limit: 3 }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: { code: 'idempotency_conflict' } });
  });

  it('uses the workspace duration snapshot as the claim deadline', async () => {
    let time = new Date('2026-09-06T00:00:00.000Z');
    const f = await drainSeed(await taskFixture(cleanup, () => time));
    const limits = new ExecutionLimitService(f.pool, () => time);
    await limits.putWorkspacePolicy(f.owner.user.id, f.owner.workspace.id, {
      maxDurationSeconds: 1,
    });
    const tasks = new TaskService(f.pool, () => time);
    const task = await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'short-deadline',
      body: 'Finish quickly.',
    });
    expect(task.limits).toMatchObject({
      durationMs: 1000,
      durationSource: 'workspace',
    });
    const worker = f.worker(async () => {
      time = new Date(time.getTime() + 1001);
      return {
        events: [
          { type: 'text', text: 'Too late.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      };
    });
    expect(await worker.runOnce()).toBe(true);
    expect(
      await tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id),
    ).toMatchObject({
      status: 'failed',
      runs: [{ error: 'execution_timeout', output: null }],
    });
  });
});

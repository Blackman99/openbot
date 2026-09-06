import { afterEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { taskFixture } from '../helpers/task-fixture.js';

describe('COL-12 Task starting limit snapshots', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function snapshot(
    pool: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    },
    taskId: string,
  ) {
    const row = (
      await pool.query(
        `SELECT max_duration_ms,duration_source,max_turns,turns_source,max_delegation_depth,delegation_depth_source,max_handoffs,handoffs_source
         FROM task_execution_limit_snapshots WHERE task_id=$1`,
        [taskId],
      )
    ).rows[0];
    if (!row) return row;
    return {
      max_duration_ms: Number(row.max_duration_ms),
      duration_source: row.duration_source,
      max_turns: Number(row.max_turns),
      turns_source: row.turns_source,
      max_delegation_depth: Number(row.max_delegation_depth),
      delegation_depth_source: row.delegation_depth_source,
      max_handoffs: row.max_handoffs === null ? null : Number(row.max_handoffs),
      handoffs_source: row.handoffs_source,
    };
  }

  it('stores an immutable Bot-sourced snapshot on a new Task', async () => {
    const f = await taskFixture(cleanup);
    expect(await snapshot(f.pool, f.task.id)).toEqual({
      max_duration_ms: 300000,
      duration_source: 'task',
      max_turns: 8,
      turns_source: 'task',
      max_delegation_depth: 2,
      delegation_depth_source: 'task',
      max_handoffs: null,
      handoffs_source: null,
    });
    const replayed = await f.tasks.submit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      {
        idempotencyKey: 'initial-task',
        body: 'Explain the evidence.',
      },
    );
    expect(replayed.id).toBe(f.task.id);
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS n FROM task_execution_limit_snapshots WHERE task_id=$1',
          [f.task.id],
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('resolves Workspace and Group templates onto the root Task without rewriting later policy edits', async () => {
    const f = await taskFixture(cleanup);
    await f.pool.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
      f.owner.workspace.id,
      JSON.stringify({ maxDurationSeconds: 60, maxHandoffs: 1 }),
    ]);
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Limit group',
    });
    await f.pool.query('UPDATE groups SET execution_policy=$2::jsonb WHERE id=$1', [
      group.id,
      JSON.stringify({ maxTurns: 3 }),
    ]);
    const shared = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
      name: 'Shared limits',
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
    const grant = await new GroupBotService(new PostgresGroupBotRepository(f.pool)).invite(
      f.owner.user.id,
      f.owner.workspace.id,
      group.id,
      { botId: sharedBot.id, idempotencyKey: 'limit-invite' },
    );
    const task = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, grant.conversationId, {
      idempotencyKey: 'group-limits',
      body: 'Use the stricter templates.',
      groupGrantId: grant.id,
    });
    const stored = await snapshot(f.pool, task.id);
    expect(stored).toEqual({
      max_duration_ms: 60000,
      duration_source: 'workspace',
      max_turns: 3,
      turns_source: 'group',
      max_delegation_depth: 2,
      delegation_depth_source: 'task',
      max_handoffs: 1,
      handoffs_source: 'workspace',
    });
    await f.pool.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
      f.owner.workspace.id,
      JSON.stringify({ maxDurationSeconds: 10, maxHandoffs: 9 }),
    ]);
    expect(await snapshot(f.pool, task.id)).toEqual(stored);
  });
});

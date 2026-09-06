import { afterEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { taskFixture } from '../helpers/task-fixture.js';
import type { ModelResponse } from '../../src/providers/model-events.js';

describe('COL-14 bounded child delegation', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function groupFixture() {
    const f = await taskFixture(cleanup, () => new Date(), { submitInitialTask: false });
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Delegation group',
    });
    await f.pool.query('UPDATE groups SET execution_policy=$2::jsonb WHERE id=$1', [
      group.id,
      JSON.stringify({ maxConcurrentRuns: 16, maxDelegationDepth: 2 }),
    ]);
    const shared = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
      name: 'Shared delegation',
      baseUrl: 'https://models.example/v1',
      modelId: 'shared-model',
      apiKey: 'shared-delegation-secret',
      headers: {},
    });
    const bots = new BotService(new PostgresBotRepository(f.pool));
    const binding = {
      scope: { kind: 'workspace' as const, id: f.owner.workspace.id },
      connectionId: shared.id,
      modelId: shared.modelId,
    };
    const lead = await bots.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Lead',
      roleDescription: 'Coordinator',
      instructions: 'Delegate when needed.',
      modelBinding: binding,
    });
    const specialist = await bots.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Researcher',
      roleDescription: 'Specialist',
      instructions: 'Answer the delegated brief.',
      modelBinding: binding,
    });
    const grants = new GroupBotService(new PostgresGroupBotRepository(f.pool));
    const leadGrant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
      botId: lead.id,
      idempotencyKey: 'lead-invite',
    });
    const specialistGrant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
      botId: specialist.id,
      idempotencyKey: 'specialist-invite',
    });
    const task = await f.tasks.submit(
      f.owner.user.id,
      f.owner.workspace.id,
      leadGrant.conversationId,
      {
        idempotencyKey: 'lead-task',
        body: 'Prepare the brief and mention @Researcher in prose.',
        groupGrantId: leadGrant.id,
      },
    );
    return {
      ...f,
      group,
      grants,
      lead,
      specialist,
      leadGrant,
      specialistGrant,
      task,
      read: () =>
        f.tasks.get(f.owner.user.id, f.owner.workspace.id, leadGrant.conversationId, task.id),
    };
  }

  function complete(text: string): ModelResponse {
    return {
      events: [
        { type: 'text', text },
        { type: 'complete', stopReason: 'stop' },
      ],
      raw: '',
    };
  }

  it('creates one child only from a schema-valid action and ignores prose', async () => {
    const f = await groupFixture();
    const worker = f.worker(async (_input) =>
      complete('Ask @Researcher: {"name":"delegate","arguments":{"instruction":"Go"}}'),
    );
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({ status: 'completed' });
    expect(
      (await f.pool.query('SELECT id FROM tasks WHERE parent_task_id=$1', [f.task.id])).rows,
    ).toEqual([]);

    const g = await groupFixture();
    const delegated = g.worker(async () => ({
      events: [
        {
          type: 'action',
          id: 'call-1',
          name: 'delegate',
          arguments: {
            grantId: g.specialistGrant.id,
            body: 'Summarize the evidence.',
          },
        },
        { type: 'complete', stopReason: 'tool_calls' },
      ],
      raw: '',
    }));
    expect(await delegated.runOnce()).toBe(true);
    const parent = await g.read();
    expect(parent.status).toBe('waiting_child');
    expect(parent.runs[0]).toMatchObject({ status: 'waiting_child', output: null, error: null });
    const child = (
      await g.pool.query<{
        id: string;
        root_task_id: string;
        parent_task_id: string;
        depth: number;
        bot_id: string;
        group_grant_id: string;
      }>(
        'SELECT id,root_task_id,parent_task_id,depth,bot_id,group_grant_id FROM tasks WHERE parent_task_id=$1',
        [g.task.id],
      )
    ).rows[0];
    if (!child) throw new Error('expected delegated child');
    expect(child).toMatchObject({
      root_task_id: g.task.id,
      parent_task_id: g.task.id,
      depth: 1,
      bot_id: g.specialist.id,
      group_grant_id: g.specialistGrant.id,
    });
    const snapshot = (
      await g.pool.query<{ max_duration_ms: string | number; max_turns: number }>(
        'SELECT max_duration_ms,max_turns FROM task_execution_limit_snapshots WHERE task_id=$1',
        [child.id],
      )
    ).rows[0]!;
    const parentSnapshot = (
      await g.pool.query<{ max_duration_ms: string | number; max_turns: number }>(
        'SELECT max_duration_ms,max_turns FROM task_execution_limit_snapshots WHERE task_id=$1',
        [g.task.id],
      )
    ).rows[0]!;
    expect(Number(snapshot.max_duration_ms)).toBeGreaterThan(0);
    expect(Number(snapshot.max_duration_ms)).toBeLessThanOrEqual(
      Number(parentSnapshot.max_duration_ms),
    );
    expect(snapshot.max_turns).toBeGreaterThan(0);
    expect(snapshot.max_turns).toBeLessThanOrEqual(parentSnapshot.max_turns);
  });

  it('rejects inactive, unauthorized, and cross-group targets without creating a child', async () => {
    const f = await groupFixture();
    await f.grants.remove(f.owner.user.id, f.owner.workspace.id, f.group.id, f.specialistGrant.id, {
      idempotencyKey: 'remove-specialist',
    });
    const worker = f.worker(async () => ({
      events: [
        {
          type: 'action',
          id: 'call-1',
          name: 'delegate',
          arguments: {
            grantId: f.specialistGrant.id,
            body: 'This grant is closed.',
          },
        },
        { type: 'complete', stopReason: 'tool_calls' },
      ],
      raw: '',
    }));
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runs: [{ error: 'provider_failed' }],
    });
    expect(
      (await f.pool.query('SELECT id FROM tasks WHERE parent_task_id=$1', [f.task.id])).rows,
    ).toEqual([]);
  });

  it('resumes the Lead with exactly one attributed Run after the child terminates', async () => {
    const f = await groupFixture();
    let stage: 'delegate' | 'child' | 'lead' = 'delegate';
    const worker = f.worker(async (input) => {
      if (stage === 'delegate') {
        stage = 'child';
        return {
          events: [
            {
              type: 'action',
              id: 'call-1',
              name: 'delegate',
              arguments: {
                grantId: f.specialistGrant.id,
                body: 'Summarize the evidence.',
              },
            },
            { type: 'complete', stopReason: 'tool_calls' },
          ],
          raw: '',
        };
      }
      if (stage === 'child') {
        expect(
          input.messages.some((message) => message.content.includes('Summarize the evidence.')),
        ).toBe(true);
        stage = 'lead';
        return complete('Child findings.');
      }
      expect(input.messages.some((message) => message.content.includes('Child findings.'))).toBe(
        true,
      );
      expect(input.messages.some((message) => message.content.includes('Researcher'))).toBe(true);
      return complete('Lead conclusion.');
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    const afterChild = await f.read();
    expect(afterChild.status).toBe('queued');
    expect(afterChild.runCount).toBe(2);
    const queued = (
      await f.pool.query<{ metadata: { origin?: string; childTaskId?: string } }>(
        `SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'taskId'=$1
         ORDER BY occurred_at DESC LIMIT 1`,
        [f.task.id],
      )
    ).rows[0]!.metadata;
    expect(queued.origin).toBe('child_result');
    expect(queued.origin).not.toMatch(/provider_retry|model_fallback|worker_recovery/);
    expect(await worker.runOnce()).toBe(true);
    const final = await f.read();
    expect(final).toMatchObject({
      status: 'completed',
      runCount: 2,
      runs: [{ status: 'completed' }],
    });
    expect(
      (
        await f.pool.query(
          `SELECT count(*)::int AS n FROM task_runs WHERE task_id=$1 AND status='queued'`,
          [f.task.id],
        )
      ).rows[0],
    ).toMatchObject({ n: 0 });
  });

  it('cancels an unfinished child when the waiting parent is cancelled', async () => {
    const f = await groupFixture();
    const worker = f.worker(async () => ({
      events: [
        {
          type: 'action',
          id: 'call-1',
          name: 'delegate',
          arguments: {
            grantId: f.specialistGrant.id,
            body: 'Never start this.',
          },
        },
        { type: 'complete', stopReason: 'tool_calls' },
      ],
      raw: '',
    }));
    expect(await worker.runOnce()).toBe(true);
    const parent = await f.read();
    expect(parent.status).toBe('waiting_child');
    const child = (
      await f.pool.query<{ id: string; status: string }>(
        'SELECT id,status FROM tasks WHERE parent_task_id=$1',
        [f.task.id],
      )
    ).rows[0]!;
    expect(child.status).toBe('queued');
    await f.tasks.cancel(
      f.owner.user.id,
      f.owner.workspace.id,
      f.leadGrant.conversationId,
      f.task.id,
      { idempotencyKey: 'stop-parent', expectedRunId: parent.runs[0]!.id },
    );
    expect(await f.read()).toMatchObject({ status: 'cancelled' });
    expect(
      (await f.pool.query<{ status: string }>('SELECT status FROM tasks WHERE id=$1', [child.id]))
        .rows[0],
    ).toEqual({ status: 'cancelled' });
  });
});

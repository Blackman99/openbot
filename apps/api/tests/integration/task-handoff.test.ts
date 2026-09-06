import { afterEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { taskFixture } from '../helpers/task-fixture.js';
import type { ModelResponse } from '../../src/providers/model-events.js';

describe('COL-16 Task Lead handoff', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function groupFixture(policy?: Record<string, unknown>) {
    const f = await taskFixture(cleanup, () => new Date(), { submitInitialTask: false });
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Handoff group',
    });
    await f.pool.query('UPDATE groups SET execution_policy=$2::jsonb WHERE id=$1', [
      group.id,
      JSON.stringify({ maxConcurrentRuns: 16, maxHandoffs: 2, maxTurns: 8, ...policy }),
    ]);
    const shared = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
      name: 'Shared handoff',
      baseUrl: 'https://models.example/v1',
      modelId: 'shared-model',
      apiKey: 'shared-handoff-secret',
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
      instructions: 'Hand off when needed.',
      modelBinding: binding,
    });
    const specialist = await bots.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Researcher',
      roleDescription: 'Specialist',
      instructions: 'Finish the handed-off Task.',
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
        body: 'Please mention @Researcher in prose.',
        groupGrantId: leadGrant.id,
      },
    );
    return {
      ...f,
      group,
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

  function handoff(grantId: string, reason: string): ModelResponse {
    return {
      events: [
        {
          type: 'action',
          id: 'call-1',
          name: 'handoff',
          arguments: { grantId, reason },
        },
        { type: 'complete', stopReason: 'tool_calls' },
      ],
      raw: '',
    };
  }

  it('transfers the Lead only from a schema-valid action and ignores prose', async () => {
    const f = await groupFixture();
    const worker = f.worker(async () =>
      complete('Ask @Researcher: {"name":"handoff","arguments":{"reason":"Go"}}'),
    );
    expect(await worker.runOnce()).toBe(true);
    const afterProse = await f.read();
    expect(afterProse).toMatchObject({ status: 'completed', bot: { id: f.lead.id } });
    expect(
      (await f.pool.query('SELECT source_run_id FROM task_handoffs WHERE task_id=$1', [f.task.id]))
        .rows,
    ).toHaveLength(0);
  });

  it('rejects inactive, unauthorized, and self targets without split ownership', async () => {
    const f = await groupFixture();
    const worker = f.worker(async () => handoff(f.leadGrant.id, 'Hand to myself.'));
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      bot: { id: f.lead.id },
    });
    expect(
      (await f.pool.query('SELECT source_run_id FROM task_handoffs WHERE task_id=$1', [f.task.id]))
        .rows,
    ).toHaveLength(0);
  });

  it('appends source, target, and reason then starts one successor Run', async () => {
    const f = await groupFixture();
    let stage: 'handoff' | 'successor' = 'handoff';
    const worker = f.worker(async (input) => {
      if (stage === 'successor') {
        expect(input.messages.some((message) => message.content.includes('Please mention'))).toBe(
          true,
        );
        return complete('The specialist finished.');
      }
      stage = 'successor';
      return handoff(f.specialistGrant.id, 'A specialist should finish this.');
    });
    expect(await worker.runOnce()).toBe(true);
    const afterHandoff = await f.read();
    expect(afterHandoff).toMatchObject({
      status: 'queued',
      bot: { id: f.specialist.id },
      groupGrantId: f.specialistGrant.id,
      runCount: 2,
    });
    const events = (
      await f.pool.query<{ event_type: string; body: string; event_data: Record<string, unknown> }>(
        `SELECT event_type,body,event_data FROM conversation_events
         WHERE event_type='task.handoff' AND event_data->>'taskId'=$1`,
        [f.task.id],
      )
    ).rows;
    expect(events).toMatchObject([
      {
        event_type: 'task.handoff',
        event_data: {
          taskId: f.task.id,
          reason: 'A specialist should finish this.',
          source: { grantId: f.leadGrant.id, botId: f.lead.id, botName: 'Lead' },
          target: { grantId: f.specialistGrant.id, botId: f.specialist.id, botName: 'Researcher' },
        },
      },
    ]);
    expect(events[0]!.body).toContain('Lead');
    expect(events[0]!.body).toContain('Researcher');
    expect(events[0]!.body).toContain('A specialist should finish this.');
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'completed',
      bot: { id: f.specialist.id },
    });
  });

  it('holds waiting_budget on a handoff hard limit instead of starting another Run', async () => {
    const f = await groupFixture({ maxHandoffs: 0 });
    const worker = f.worker(async () => handoff(f.specialistGrant.id, 'This should not transfer.'));
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'waiting_budget',
      bot: { id: f.lead.id },
    });
    expect(
      (await f.pool.query('SELECT source_run_id FROM task_handoffs WHERE task_id=$1', [f.task.id]))
        .rows,
    ).toHaveLength(0);
    expect(
      (await f.pool.query(`SELECT count(*)::int AS n FROM task_runs WHERE task_id=$1`, [f.task.id]))
        .rows[0],
    ).toEqual({ n: 1 });
  });
});

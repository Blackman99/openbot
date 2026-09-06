import { afterEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { taskFixture } from '../helpers/task-fixture.js';
import { TaskAccessError, TaskConflictError } from '../../src/tasks/errors.js';
import type { ModelResponse } from '../../src/providers/model-events.js';

const schema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: { note: { type: 'string' as const } },
  required: ['note'],
};

describe('COL-19 human input and approval holds', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  function complete(text: string): ModelResponse {
    return {
      events: [
        { type: 'text', text },
        { type: 'complete', stopReason: 'stop' },
      ],
      raw: '',
    };
  }

  function requestInput(): ModelResponse {
    return {
      events: [
        {
          type: 'action',
          id: 'call-1',
          name: 'request_input',
          arguments: { prompt: 'What should we keep?', responseSchema: schema },
        },
        { type: 'complete', stopReason: 'tool_calls' },
      ],
      raw: '',
    };
  }

  function requestApproval(summary = 'Publish the draft.'): ModelResponse {
    return {
      events: [
        {
          type: 'action',
          id: 'call-1',
          name: 'request_approval',
          arguments: { summary },
        },
        { type: 'complete', stopReason: 'tool_calls' },
      ],
      raw: '',
    };
  }

  it('parks a valid request_input and resumes once from authorized input', async () => {
    const f = await taskFixture(cleanup);
    const waiting = f.worker(async () => requestInput());
    expect(await waiting.runOnce()).toBe(true);
    const parked = await f.read();
    expect(parked.status).toBe('waiting_input');
    expect(parked.runs[0]).toMatchObject({ status: 'waiting_input', error: null, output: null });
    expect(parked.humanRequest).toMatchObject({
      kind: 'input',
      prompt: 'What should we keep?',
      responseSchema: schema,
    });
    expect(await f.worker(async () => complete('should not start')).runOnce()).toBe(false);
    expect(await f.read()).toMatchObject({ status: 'waiting_input', runCount: 1 });
    const decided = await f.tasks.decide(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      f.task.id,
      { idempotencyKey: 'input-1', values: { note: 'Keep the citation.' } },
    );
    expect(decided.task.status).toBe('queued');
    expect(decided.task.runCount).toBe(2);
    expect(decided.task.humanRequest).toBeUndefined();
    expect(decided.decision).toMatchObject({ attempt: 2 });
    const replay = await f.tasks.decide(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      f.task.id,
      { idempotencyKey: 'input-1', values: { note: 'Keep the citation.' } },
    );
    expect(replay.decision.runId).toBe(decided.decision.runId);
    await expect(
      f.tasks.decide(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id, {
        idempotencyKey: 'input-1',
        values: { note: 'Different payload.' },
      }),
    ).rejects.toBeInstanceOf(TaskConflictError);
    let sawAttribution = false;
    const successor = f.worker(async (input) => {
      sawAttribution = input.messages.some((message) =>
        message.content.includes('Human input:\nnote: Keep the citation.'),
      );
      return complete('Saved the citation.');
    });
    expect(await successor.runOnce()).toBe(true);
    expect(sawAttribution).toBe(true);
    expect(await f.read()).toMatchObject({ status: 'completed', runCount: 2 });
    const events = (
      await f.pool.query<{ event_type: string }>(
        `SELECT event_type FROM conversation_events
         WHERE conversation_id=$1 AND event_type IN ('task.input.requested','task.human.decided')
         ORDER BY sequence`,
        [f.conversation.id],
      )
    ).rows.map((row) => row.event_type);
    expect(events).toEqual(['task.input.requested', 'task.human.decided']);
  });

  it('parks request_approval, rejects mixed actions, and stays cancellable', async () => {
    const f = await taskFixture(cleanup);
    const mixed = f.worker(async () => ({
      events: [
        {
          type: 'action',
          id: 'call-1',
          name: 'request_approval',
          arguments: { summary: 'Ship it.' },
        },
        {
          type: 'action',
          id: 'call-2',
          name: 'request_input',
          arguments: { prompt: 'Also ask', responseSchema: schema },
        },
        { type: 'complete', stopReason: 'tool_calls' },
      ],
      raw: '',
    }));
    expect(await mixed.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({ status: 'failed' });
    const second = await taskFixture(cleanup);
    expect(await second.worker(async () => requestApproval()).runOnce()).toBe(true);
    const parked = await second.read();
    expect(parked.status).toBe('waiting_approval');
    expect(parked.humanRequest).toMatchObject({
      kind: 'approval',
      summary: 'Publish the draft.',
    });
    await second.tasks.cancel(
      second.owner.user.id,
      second.owner.workspace.id,
      second.conversation.id,
      second.task.id,
      { idempotencyKey: 'cancel-waiting', expectedRunId: parked.runs[0]!.id },
    );
    expect(await second.read()).toMatchObject({ status: 'cancelled' });
  });

  it('lets a group member approve and denies a workspace outsider', async () => {
    const f = await taskFixture(cleanup, () => new Date(), { submitInitialTask: false });
    const member = await f.addUser();
    const outsider = await f.addUser();
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Approval group',
    });
    await groups.addMember(f.owner.user.id, f.owner.workspace.id, group.id, {
      userId: member.id,
      role: 'member',
    });
    const shared = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
      name: 'Shared approval',
      baseUrl: 'https://models.example/v1',
      modelId: 'shared-model',
      apiKey: 'shared-approval-secret',
      headers: {},
    });
    const bot = await new BotService(new PostgresBotRepository(f.pool)).create(
      f.owner.user.id,
      f.owner.workspace.id,
      {
        name: 'Reviewer',
        roleDescription: 'Asks for approval',
        instructions: 'Ask before publishing.',
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
      { botId: bot.id, idempotencyKey: 'reviewer-invite' },
    );
    const task = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, grant.conversationId, {
      idempotencyKey: 'approval-task',
      body: 'Draft the announcement.',
      groupGrantId: grant.id,
    });
    expect(await f.worker(async () => requestApproval('Send the announcement.')).runOnce()).toBe(
      true,
    );
    const parked = await f.tasks.get(
      f.owner.user.id,
      f.owner.workspace.id,
      grant.conversationId,
      task.id,
    );
    expect(parked.status).toBe('waiting_approval');
    await expect(
      f.tasks.decide(outsider.id, f.owner.workspace.id, grant.conversationId, task.id, {
        idempotencyKey: 'outsider',
        decision: 'approve',
      }),
    ).rejects.toBeInstanceOf(TaskAccessError);
    const decided = await f.tasks.decide(
      member.id,
      f.owner.workspace.id,
      grant.conversationId,
      task.id,
      {
        idempotencyKey: 'member-approve',
        decision: 'approve',
      },
    );
    expect(decided.task.status).toBe('queued');
    expect(decided.task.runCount).toBe(2);
    let sawAttribution = false;
    expect(
      await f
        .worker(async (input) => {
          sawAttribution = input.messages.some((message) =>
            message.content.includes('Human approved: Send the announcement.'),
          );
          return complete('Published.');
        })
        .runOnce(),
    ).toBe(true);
    expect(sawAttribution).toBe(true);
  });
});

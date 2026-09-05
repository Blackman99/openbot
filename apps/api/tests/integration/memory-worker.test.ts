import { afterEach, describe, expect, it } from 'vitest';
import { memoryFixture } from '../helpers/memory-fixture.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import type { ModelInput } from '../../src/providers/model-events.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await memoryFixture(cleanup);
  const saved = await f.memories.create(
    { actorUserId: f.owner.user.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
    f.command,
  );
  const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    botId: f.bot.id,
    idempotencyKey: 'all',
    history: { mode: 'all' },
  });
  const tasks = new TaskService(f.pool);
  const task = await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
    body: 'Answer using the saved group memory.',
    idempotencyKey: 'later-run',
    groupGrantId: grant.id,
  });
  return { ...f, saved: saved.memory, grant, tasks, task };
}
describe('memory at the provider boundary', () => {
  it('stops later streamed deltas when a selected source changes, retaining only bytes legitimately published before the change', async () => {
    const f = await fixture();
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (_input, _signal, onEvent) => {
          await onEvent?.({ type: 'text', text: 'Visible before the source edit.' });
          await f.conversations.edit(
            f.owner.user.id,
            f.owner.workspace.id,
            f.conversation.id,
            f.source.messageId,
            {
              idempotencyKey: 'edit-after-first-delta',
              expectedVersion: 1,
              body: 'The source is now different.',
            },
          );
          await onEvent?.({ type: 'text', text: 'stale'.repeat(1000) });
          return {
            events: [
              { type: 'text', text: 'Must not finish.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    expect(
      (
        await f.pool.query(
          "SELECT delta_text FROM conversation_delivery_events WHERE run_id=$1 AND event_type='assistant.delta' ORDER BY sequence",
          [f.task.runs[0]!.id],
        )
      ).rows,
    ).toEqual([{ delta_text: 'Visible before the source edit.' }]);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id),
    ).toMatchObject({ status: 'failed', runs: [{ error: 'execution_forbidden', output: null }] });
  });
  it('sends an identified saved memory and records exactly the source references included in a later same-group Run', async () => {
    const f = await fixture();
    let sent: ModelInput['messages'] = [];
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          sent = input.messages;
          return {
            events: [
              { type: 'text', text: 'Cobalt is the saved code.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    const contribution = sent.find((message) =>
      message.content.startsWith('{"kind":"group_memories"'),
    );
    expect(contribution).toBeDefined();
    expect(JSON.parse(contribution!.content)).toMatchObject({
      memories: [
        {
          id: f.saved.id,
          versionId: f.saved.versionId,
          text: f.saved.text,
          source: { eventId: f.source.eventId },
        },
      ],
    });
    expect(
      (
        await f.pool.query(
          'SELECT run_id,memory_version_id,source_event_id FROM run_memory_references',
        )
      ).rows,
    ).toEqual([
      {
        run_id: f.task.runs[0]!.id,
        memory_version_id: f.saved.versionId,
        source_event_id: f.source.eventId,
      },
    ]);
    expect(
      (await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id))
        .status,
    ).toBe('completed');
  });
  it('blocks final publication when a selected memory source changes during provider work', async () => {
    const f = await fixture();
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async () => {
          await f.conversations.edit(
            f.owner.user.id,
            f.owner.workspace.id,
            f.conversation.id,
            f.source.messageId,
            {
              body: 'The saved code has changed.',
              expectedVersion: 1,
              idempotencyKey: 'edit-during-provider',
            },
          );
          return {
            events: [
              { type: 'text', text: 'This stale answer must not publish.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id),
    ).toMatchObject({ status: 'failed', runs: [{ error: 'execution_forbidden', output: null }] });
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE conversation_id=$1 AND event_type='bot.message.created'",
          [f.conversation.id],
        )
      ).rows,
    ).toEqual([]);
  });
});

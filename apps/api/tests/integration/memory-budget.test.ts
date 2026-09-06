import { afterEach, describe, expect, it } from 'vitest';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { selectRunMemoryContribution } from '../../src/memories/run-context.js';
import { memoryFixture } from '../helpers/memory-fixture.js';
import type { ModelInput } from '../../src/providers/model-events.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
type Fixture = Awaited<ReturnType<typeof memoryFixture>>;
async function queued(f: Fixture) {
  const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    botId: f.bot.id,
    idempotencyKey: 'all',
    history: { mode: 'all' },
  });
  const tasks = new TaskService(f.pool);
  const task = await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
    body: 'Summarize the saved evidence.',
    idempotencyKey: 'later',
    groupGrantId: grant.id,
  });
  return { tasks, task };
}
async function noProviderCall(f: Fixture, task: Awaited<ReturnType<typeof queued>>) {
  let called = false;
  const worker = new TaskWorker(f.pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async () => {
        called = true;
        return { events: [{ type: 'complete', stopReason: 'stop' }], raw: '' };
      },
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  expect(called).toBe(false);
  expect(
    await task.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.task.id),
  ).toMatchObject({ status: 'failed', runs: [{ error: 'context_limit', output: null }] });
  expect((await f.pool.query('SELECT run_id FROM run_memory_references')).rows).toEqual([]);
}
describe('memory contribution limits at the provider boundary', () => {
  it('counts the memory contribution and ordinary source history in one aggregate byte budget', async () => {
    const f = await memoryFixture(cleanup),
      sources = [];
    const access = {
      actorUserId: f.member.id,
      workspaceId: f.owner.workspace.id,
      groupId: f.group.id,
    };
    for (let index = 0; index < 3; index++)
      sources.push(
        await f.conversations.append(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
          body: `Evidence ${index} ` + 'x'.repeat(23980),
          idempotencyKey: `source-${index}`,
        }),
      );
    for (let index = 0; index < 40; index++) {
      const source = sources[index % 3]!;
      await f.memories.create(access, {
        ...f.command,
        messageId: source.messageId,
        expectedSourceEventId: source.eventId,
        idempotencyKey: `save-${index}`,
      });
    }
    const task = await queued(f),
      connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      const contribution = await selectRunMemoryContribution(connection, task.task.runs[0]!.id);
      expect(contribution.bytes).toBeLessThan(1048576);
      expect(contribution.bytes + 3 * 23990).toBeGreaterThan(1048576);
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
    let sent: ModelInput['messages'] = [];
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          sent = input.messages;
          return {
            events: [
              { type: 'text', text: 'Kept the remembered evidence.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    expect(sent[0]).toEqual({
      role: 'system',
      content: 'Instructions visible only with a direct Bot grant.',
    });
    expect(sent.some((message) => message.content.includes('group_memories'))).toBe(true);
    expect(
      sent.reduce((total, message) => total + Buffer.byteLength(message.content), 0),
    ).toBeLessThanOrEqual(1048576);
    expect(sent.filter((message) => message.content.startsWith('Evidence ')).length).toBeLessThan(
      3,
    );
    expect(
      await task.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.task.id),
    ).toMatchObject({ status: 'completed' });
  }, 15000);
  it('fails a claim with more than 100 eligible saved memories without recording a truncated sent manifest', async () => {
    const f = await memoryFixture(cleanup);
    for (let index = 0; index < 101; index++)
      await f.memories.create(
        { actorUserId: f.member.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
        { ...f.command, idempotencyKey: `save-${index}` },
      );
    await noProviderCall(f, await queued(f));
  }, 15000);
});

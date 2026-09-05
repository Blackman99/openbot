import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { memoryFixture } from '../helpers/memory-fixture.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('memory scope at the provider boundary', () => {
  it('runs Bots in another group and workspace without selecting or recording the saved source from either foreign scope', async () => {
    const f = await memoryFixture(cleanup);
    const saved = (
      await f.memories.create(
        { actorUserId: f.member.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
        f.command,
      )
    ).memory;
    const workspaceId = randomUUID();
    await f.pool.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,$3)', [
      workspaceId,
      'Other workspace',
      new Date(),
    ]);
    const otherOwner = await f.addUser('owner', workspaceId);
    const model = await f.providers.save(otherOwner.id, {
      name: 'Other model',
      protocol: 'openai-chat',
      baseUrl: 'https://models.example/v1',
      modelId: 'other-model',
      apiKey: 'other-model-secret',
      headers: {},
    });
    const otherBot = await new BotService(new PostgresBotRepository(f.pool)).create(
      otherOwner.id,
      workspaceId,
      {
        name: 'Other Bot',
        roleDescription: 'Researcher',
        instructions: 'Use only this workspace.',
        modelBinding: {
          scope: { kind: 'personal', id: otherOwner.id },
          connectionId: model.id,
          modelId: model.modelId,
        },
      },
    );
    const tasks = new TaskService(f.pool);
    for (const scope of [
      { workspaceId: f.owner.workspace.id, actorId: f.owner.user.id, botId: f.bot.id },
      { workspaceId, actorId: otherOwner.id, botId: otherBot.id },
    ]) {
      const group = await f.groups.create(scope.actorId, scope.workspaceId, {
        name: 'Other group',
      });
      const grant = await f.grants.invite(scope.actorId, scope.workspaceId, group.id, {
        botId: scope.botId,
        idempotencyKey: 'invite',
        history: { mode: 'all' },
      });
      const task = await tasks.submit(scope.actorId, scope.workspaceId, grant.conversationId, {
        body: 'Answer from this group only.',
        groupGrantId: grant.id,
        idempotencyKey: 'run',
      });
      let called = false;
      const worker = new TaskWorker(f.pool, {
        secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
        createAdapter: () => ({
          generate: async (input) => {
            called = true;
            expect(
              input.messages.some(
                (message) =>
                  message.content.includes(saved.text) ||
                  message.content.includes(saved.id) ||
                  message.content.includes('group_memories'),
              ),
            ).toBe(false);
            expect(input.messages.at(-1)).toEqual({
              role: 'user',
              content: 'Answer from this group only.',
            });
            return {
              events: [
                { type: 'text', text: 'Scoped answer.' },
                { type: 'complete', stopReason: 'stop' },
              ],
              raw: '',
            };
          },
        }),
      });
      expect(await worker.runOnce()).toBe(true);
      expect(called).toBe(true);
      expect(
        await tasks.get(scope.actorId, scope.workspaceId, grant.conversationId, task.id),
      ).toMatchObject({ status: 'completed' });
      expect(
        (
          await f.pool.query(
            'SELECT memory_version_id FROM run_memory_references WHERE run_id=$1',
            [task.runs[0]!.id],
          )
        ).rows,
      ).toEqual([]);
    }
  });
});

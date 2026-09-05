import { afterEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { BOT_PRIVATE_VISIBILITY_SUMMARY } from '../../src/memories/types.js';
import { memoryFixture } from '../helpers/memory-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('MEM-02 group memory promotion to Bot-private memory', () => {
  async function saved(f: Awaited<ReturnType<typeof memoryFixture>>) {
    const created = await f.app.inject({
      method: 'POST',
      url: f.path,
      headers: f.headers,
      payload: f.command,
    });
    expect(created.statusCode).toBe(201);
    return created.json().memory as { id: string; text: string };
  }

  it('previews source, destination Bot, visibility and content, then promotes only after explicit confirmation', async () => {
    const f = await memoryFixture(cleanup);
    const memory = await saved(f);
    const preview = await f.app.inject({
      method: 'POST',
      url: `${f.path}/${memory.id}/promotion-previews`,
      headers: f.headers,
      payload: { destinationBotId: f.bot.id },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({
      source: { groupId: f.group.id, memoryId: memory.id, text: memory.text },
      destinationBot: { id: f.bot.id, name: 'Private helper' },
      visibility: {
        kind: 'bot-private',
        botId: f.bot.id,
        summary: BOT_PRIVATE_VISIBILITY_SUMMARY,
      },
      content: memory.text,
    });
    expect((await f.pool.query('SELECT id FROM bot_private_memories')).rows).toEqual([]);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/${memory.id}/promotions`,
          headers: f.headers,
          payload: {
            intentId: preview.json().preview.id,
            idempotencyKey: 'promote-1',
            acknowledged: false,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect((await f.pool.query('SELECT id FROM bot_private_memories')).rows).toEqual([]);
    const confirmed = await f.app.inject({
      method: 'POST',
      url: `${f.path}/${memory.id}/promotions`,
      headers: f.headers,
      payload: {
        intentId: preview.json().preview.id,
        idempotencyKey: 'promote-1',
        acknowledged: true,
      },
    });
    expect(confirmed.statusCode).toBe(201);
    const promoted = confirmed.json().memory;
    expect(promoted).toMatchObject({
      version: 1,
      scope: { kind: 'bot-private', workspaceId: f.owner.workspace.id, botId: f.bot.id },
      sourceGroupId: f.group.id,
      sourceMemoryId: memory.id,
      approver: { id: f.owner.user.id },
      text: memory.text,
    });
    expect(Date.parse(String(promoted.approvedAt))).toBeGreaterThan(0);
    expect(
      (
        await f.pool.query(
          "SELECT metadata FROM audit_events WHERE event_type='memory.promoted' ORDER BY occurred_at",
        )
      ).rows,
    ).toMatchObject([{ metadata: { sourceMemoryId: memory.id, botId: f.bot.id } }]);
    expect(
      JSON.stringify(
        (await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='memory.promoted'"))
          .rows,
      ),
    ).not.toContain('cobalt');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/${memory.id}/promotions`,
          headers: f.headers,
          payload: {
            intentId: preview.json().preview.id,
            idempotencyKey: 'promote-1',
            acknowledged: true,
          },
        })
      ).json().memory.id,
    ).toBe(promoted.id);
    expect((await f.pool.query('SELECT id FROM bot_private_memories')).rows).toHaveLength(1);
  });

  it('lets the destination Bot use the promoted memory in another group and hides it from every other Bot', async () => {
    const f = await memoryFixture(cleanup);
    const memory = await saved(f);
    const preview = await f.app.inject({
      method: 'POST',
      url: `${f.path}/${memory.id}/promotion-previews`,
      headers: f.headers,
      payload: { destinationBotId: f.bot.id },
    });
    const promoted = (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/${memory.id}/promotions`,
        headers: f.headers,
        payload: {
          intentId: preview.json().preview.id,
          idempotencyKey: 'promote-cross-group',
          acknowledged: true,
        },
      })
    ).json().memory;
    const listed = await f.app.inject({
      url: `/api/v1/workspaces/${f.owner.workspace.id}/bots/${f.bot.id}/private-memories`,
      headers: f.headers,
    });
    expect(listed.json().memories).toMatchObject([{ id: promoted.id, sourceMemoryId: memory.id }]);
    const otherBot = await new BotService(new PostgresBotRepository(f.pool)).create(
      f.owner.user.id,
      f.owner.workspace.id,
      {
        name: 'Other helper',
        roleDescription: 'Researcher',
        instructions: 'Stay isolated.',
        modelBinding: {
          scope: { kind: 'personal', id: f.owner.user.id },
          connectionId: f.model.id,
          modelId: f.model.modelId,
        },
      },
    );
    expect(
      (
        await f.app.inject({
          url: `/api/v1/workspaces/${f.owner.workspace.id}/bots/${otherBot.id}/private-memories`,
          headers: f.headers,
        })
      ).json().memories,
    ).toEqual([]);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/v1/workspaces/${f.owner.workspace.id}/bots/${otherBot.id}/private-memories/search`,
          headers: f.headers,
          payload: { query: 'cobalt' },
        })
      ).json().memories,
    ).toEqual([]);
    const otherGroup = await f.groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Second group',
    });
    const destGrant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, otherGroup.id, {
      botId: f.bot.id,
      idempotencyKey: 'dest-other-group',
      history: { mode: 'all' },
    });
    const otherGrant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, otherGroup.id, {
      botId: otherBot.id,
      idempotencyKey: 'other-bot',
      history: { mode: 'all' },
    });
    const tasks = new TaskService(f.pool);
    const destTask = await tasks.submit(
      f.owner.user.id,
      f.owner.workspace.id,
      destGrant.conversationId,
      {
        body: 'Use private memory.',
        groupGrantId: destGrant.id,
        idempotencyKey: 'dest-run',
      },
    );
    const otherTask = await tasks.submit(
      f.owner.user.id,
      f.owner.workspace.id,
      otherGrant.conversationId,
      {
        body: 'Do not see private memory.',
        groupGrantId: otherGrant.id,
        idempotencyKey: 'other-run',
      },
    );
    const seen: string[] = [];
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          seen.push(input.messages.map((message) => message.content).join('\n'));
          return {
            events: [
              { type: 'text', text: 'Answer.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    const destInput = seen.find(
      (content) => content.includes(destTask.id) || content.includes('cobalt'),
    );
    expect(seen.some((content) => content.includes('bot_private_memories'))).toBe(true);
    expect(seen.some((content) => content.includes(memory.text))).toBe(true);
    expect(destInput).toBeDefined();
    const otherRun = (
      await f.pool.query<{ id: string }>('SELECT id FROM task_runs WHERE task_id=$1', [
        otherTask.id,
      ])
    ).rows[0]!;
    expect(
      (
        await f.pool.query(
          'SELECT private_memory_id FROM run_private_memory_references WHERE run_id=$1',
          [otherRun.id],
        )
      ).rows,
    ).toEqual([]);
  });

  it('returns 403 and creates no private memory without source group access or destination Bot edit permission', async () => {
    const f = await memoryFixture(cleanup);
    const memory = await saved(f);
    const outsider = await f.addUser();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/${memory.id}/promotion-previews`,
          headers: outsider.headers,
          payload: { destinationBotId: f.bot.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/${memory.id}/promotion-previews`,
          headers: f.member.headers,
          payload: { destinationBotId: f.bot.id },
        })
      ).statusCode,
    ).toBe(403);
    expect((await f.pool.query('SELECT id FROM bot_private_memories')).rows).toEqual([]);
    expect((await f.pool.query('SELECT id FROM memory_promotion_intents')).rows).toEqual([]);
    const denied = (
      await f.pool.query(
        "SELECT metadata FROM audit_events WHERE event_type='memory.access_denied' ORDER BY occurred_at",
      )
    ).rows;
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(denied)).not.toContain('cobalt');
  });
});

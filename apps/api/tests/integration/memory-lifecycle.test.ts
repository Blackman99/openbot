import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryFixture } from '../helpers/memory-fixture.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import type { MemoryProjection } from '../../src/memories/types.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('memory source lifecycle', () => {
  it('accepts visible Bot text with its exact output/version provenance but refuses system and direct sources', async () => {
    const f = await memoryFixture(cleanup);
    const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      botId: f.bot.id,
      idempotencyKey: 'join',
    });
    const tasks = new TaskService(f.pool);
    const task = await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'task',
      body: 'A Bot source please.',
      groupGrantId: grant.id,
    });
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async () => ({
          events: [
            { type: 'text', text: 'Cobalt Bot response.' },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }),
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    const final = await tasks.get(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      task.id,
    );
    expect(final.status).toBe('completed');
    const output = final.runs[0]!.output!;
    const result = await f.app.inject({
      method: 'POST',
      url: f.path,
      headers: f.member.headers,
      payload: { ...f.command, messageId: output.messageId, expectedSourceEventId: output.eventId },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().memory.source).toMatchObject({
      eventId: output.eventId,
      creationEventId: output.eventId,
      author: { kind: 'bot', id: f.bot.id, versionId: f.bot.currentVersion.id, versionNumber: 1 },
    });
    const path = f.path.replace('/memories', `/bots/${grant.id}/memories`);
    expect(
      (await f.app.inject({ url: path, headers: f.member.headers })).json().memories,
    ).toHaveLength(1);
    const direct = await f.conversations.open(f.owner.user.id, f.owner.workspace.id, {
      subject: { kind: 'direct-bot', id: f.bot.id },
    });
    const privateSource = await f.conversations.append(
      f.owner.user.id,
      f.owner.workspace.id,
      direct.id,
      { body: 'Private content', idempotencyKey: 'private' },
    );
    for (const [messageId, expectedSourceEventId] of [
      [privateSource.messageId, privateSource.eventId],
      [grant.joined.eventId, grant.joined.eventId],
    ])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: f.path,
            headers: f.headers,
            payload: {
              ...f.command,
              messageId,
              expectedSourceEventId,
              idempotencyKey: randomUUID(),
            },
          })
        ).statusCode,
      ).toBe(403);
  });
  it('does not resurrect a source reference on a stale replay, tombstone, or later re-save', async () => {
    const f = await memoryFixture(cleanup);
    const first = await f.memories.create(
      { actorUserId: f.owner.user.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
      f.command,
    );
    await f.conversations.tombstone(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      f.source.messageId,
      { idempotencyKey: 'delete', expectedVersion: 1 },
    );
    for (const command of [f.command, { ...f.command, idempotencyKey: 'new-key' }])
      expect(
        (await f.app.inject({ method: 'POST', url: f.path, headers: f.headers, payload: command }))
          .statusCode,
      ).toBe(403);
    expect(
      (await f.app.inject({ url: `${f.path}/${first.memory.id}`, headers: f.headers })).statusCode,
    ).toBe(403);
    expect((await f.app.inject({ url: f.path, headers: f.headers })).json().memories).toEqual([]);
    expect((await f.pool.query('SELECT id FROM memory_versions')).rows).toHaveLength(1);
  });
  it('excludes a purging attachment source before cleanup has removed its still-present message body', async () => {
    const f = await memoryFixture(cleanup),
      objects = new Map<string, Buffer>();
    const attachments = new AttachmentService(f.pool, {
      identity: 'test-memory-objects',
      save: async (key, bytes) => {
        objects.set(key.objectId, Buffer.from(bytes));
      },
      read: async (key) => objects.get(key.objectId)!,
      delete: async (key) => {
        objects.delete(key.objectId);
      },
    });
    const access = {
      actorUserId: f.owner.user.id,
      workspaceId: f.owner.workspace.id,
      conversationId: f.conversation.id,
    };
    const bytes = Buffer.from('Attached source bytes');
    const source = await attachments.upload(
      access,
      {
        body: 'Cobalt attachment source',
        idempotencyKey: 'upload',
        filename: 'source.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      bytes,
    );
    const response = await f.app.inject({
      method: 'POST',
      url: f.path,
      headers: f.headers,
      payload: { ...f.command, messageId: source.messageId, expectedSourceEventId: source.eventId },
    });
    expect(response.statusCode).toBe(201);
    const memory = response.json<{ memory: MemoryProjection }>().memory;
    await attachments.purge(access, source.messageId);
    expect(
      (await f.pool.query('SELECT body FROM conversation_events WHERE id=$1', [source.eventId]))
        .rows[0]!.body,
    ).toBe('Cobalt attachment source');
    expect(
      (await f.app.inject({ url: `${f.path}/${memory.id}`, headers: f.headers })).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/search`,
          headers: f.member.headers,
          payload: { query: 'attachment source' },
        })
      ).json().memories,
    ).toEqual([]);
    expect((await f.pool.query('SELECT id FROM memory_versions')).rows).toHaveLength(1);
    expect(
      JSON.stringify((await f.pool.query('SELECT * FROM memory_versions')).rows),
    ).not.toContain('Cobalt');
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryFixture } from '../helpers/memory-fixture.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('scoped memory search and pagination', () => {
  it('searches source body text case-insensitively through the scoped POST endpoint', async () => {
    const f = await memoryFixture(cleanup);
    const access = {
      actorUserId: f.member.id,
      workspaceId: f.owner.workspace.id,
      groupId: f.group.id,
    };
    const saved = [];
    for (const text of ['marker cobalt-bound evidence', 'marker copper bound evidence']) {
      const source = await f.conversations.append(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        { body: text, idempotencyKey: randomUUID() },
      );
      saved.push(
        (
          await f.memories.create(access, {
            ...f.command,
            messageId: source.messageId,
            expectedSourceEventId: source.eventId,
            idempotencyKey: randomUUID(),
          })
        ).memory,
      );
    }
    for (const query of ['COBALT-BOUND', 'cobalt-bound evidence']) {
      const result = await f.app.inject({
        method: 'POST',
        url: `${f.path}/search`,
        headers: f.member.headers,
        payload: { query },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().memories.map((memory: { id: string }) => memory.id)).toEqual([
        saved[0]!.id,
      ]);
    }
  });
  it('excludes stale sources before the page boundary and advances only through currently visible matches', async () => {
    const f = await memoryFixture(cleanup);
    const access = {
      actorUserId: f.member.id,
      workspaceId: f.owner.workspace.id,
      groupId: f.group.id,
    };
    const saved = [];
    for (let index = 0; index < 4; index++) {
      const source = await f.conversations.append(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        { body: `Searchable evidence ${index}`, idempotencyKey: `source-${index}` },
      );
      saved.push(
        (
          await f.memories.create(access, {
            ...f.command,
            messageId: source.messageId,
            expectedSourceEventId: source.eventId,
            idempotencyKey: `save-${index}`,
          })
        ).memory,
      );
    }
    saved.sort((a, b) => a.id.localeCompare(b.id));
    for (const stale of saved.slice(0, 2))
      await f.conversations.edit(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        stale.source.messageId,
        { expectedVersion: 1, body: 'Changed source', idempotencyKey: stale.id },
      );
    const first = await f.memories.list(access, { query: 'SEARCHABLE', limit: 1 }, true);
    expect(first.memories.map((memory) => memory.id)).toEqual([saved[2]!.id]);
    expect(first.nextAfter).toBe(saved[2]!.id);
    const second = await f.memories.list(
      access,
      { query: 'SEARCHABLE', limit: 1, after: first.nextAfter! },
      true,
    );
    expect(second.memories.map((memory) => memory.id)).toEqual([saved[3]!.id]);
    expect(second.nextAfter).toBeNull();
  });
});

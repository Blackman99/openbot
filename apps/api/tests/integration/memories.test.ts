import { afterEach, describe, expect, it } from 'vitest';
import { memoryFixture } from '../helpers/memory-fixture.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('group source-reference memory', () => {
  it('lets an ordinary current member save, inspect and search one immutable version without copying text', async () => {
    const f = await memoryFixture(cleanup);
    const created = await f.app.inject({
      method: 'POST',
      url: f.path,
      headers: f.member.headers,
      payload: f.command,
    });
    expect(created.statusCode).toBe(201);
    const memory = created.json().memory;
    expect(memory).toMatchObject({
      version: 1,
      confidence: 0.5,
      confidenceSource: 'human',
      text: 'The launch code is cobalt.',
      creator: { id: f.member.id },
      scope: { kind: 'group', workspaceId: f.owner.workspace.id, groupId: f.group.id },
      source: {
        eventId: f.source.eventId,
        creationEventId: f.source.eventId,
        messageId: f.source.messageId,
      },
    });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path,
          headers: f.member.headers,
          payload: f.command,
        })
      ).json().memory.id,
    ).toBe(memory.id);
    expect(
      (await f.app.inject({ url: `${f.path}/${memory.id}`, headers: f.member.headers })).json()
        .memory,
    ).toEqual(memory);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/search`,
          headers: f.member.headers,
          payload: { query: 'COBALT' },
        })
      ).json().memories,
    ).toMatchObject([{ id: memory.id }]);
    const stored = (await f.pool.query('SELECT * FROM memory_versions')).rows;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('cobalt');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path,
          headers: f.member.headers,
          payload: { ...f.command, confidence: 0.8 },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('immediately excludes a saved old revision even for its author and a group owner', async () => {
    const f = await memoryFixture(cleanup);
    const created = await f.app.inject({
      method: 'POST',
      url: f.path,
      headers: f.headers,
      payload: f.command,
    });
    expect(created.statusCode).toBe(201);
    const memory = created.json().memory;
    await f.conversations.edit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      f.source.messageId,
      { idempotencyKey: 'edit', expectedVersion: 1, body: 'The old code was revoked.' },
    );
    for (const headers of [f.headers, f.member.headers]) {
      expect((await f.app.inject({ url: `${f.path}/${memory.id}`, headers })).statusCode).toBe(403);
      expect((await f.app.inject({ url: f.path, headers })).json().memories).toEqual([]);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${f.path}/search`,
            headers,
            payload: { query: 'cobalt' },
          })
        ).json().memories,
      ).toEqual([]);
    }
    const audits = (
      await f.pool.query(
        "SELECT metadata FROM audit_events WHERE event_type='memory.access_denied'",
      )
    ).rows;
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('cobalt');
  });
  it('persists a content-free denial audit without creating an inaccessible memory', async () => {
    const f = await memoryFixture(cleanup);
    const outsider = await f.addUser();
    const result = await f.app.inject({
      method: 'POST',
      url: f.path,
      headers: outsider.headers,
      payload: f.command,
    });
    expect(result.statusCode).toBe(403);
    expect((await f.pool.query('SELECT id FROM group_memories')).rows).toEqual([]);
    expect(
      (
        await f.pool.query(
          "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='memory.access_denied'",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: outsider.id,
        metadata: {
          operation: 'create',
          workspaceId: f.owner.workspace.id,
          groupId: f.group.id,
          messageId: f.source.messageId,
        },
      },
    ]);
  });
});

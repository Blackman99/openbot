import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryFixture } from '../helpers/memory-fixture.js';
import type { MemoryProjection } from '../../src/memories/types.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
type Fixture = Awaited<ReturnType<typeof memoryFixture>>;
async function save(f: Fixture, command = f.command) {
  const result = await f.app.inject({
    method: 'POST',
    url: f.path,
    headers: f.headers,
    payload: command,
  });
  expect(result.statusCode).toBe(201);
  return result.json<{ memory: MemoryProjection }>().memory;
}
async function grantPath(f: Fixture, history?: { mode: 'all' }) {
  const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    botId: f.bot.id,
    idempotencyKey: randomUUID(),
    ...(history ? { history } : {}),
  });
  return { grant, path: f.path.replace('/memories', `/bots/${grant.id}/memories`) };
}
describe('memory permission boundary', () => {
  it('filters original creation before later edits and does not union a closed grant with its replacement', async () => {
    const f = await memoryFixture(cleanup);
    const future = await grantPath(f);
    const edited = await f.conversations.edit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      f.source.messageId,
      {
        idempotencyKey: 'edit-before-save',
        expectedVersion: 1,
        body: 'Cobalt remains earlier than the grant.',
      },
    );
    const old = await save(f, { ...f.command, expectedSourceEventId: edited.eventId });
    const source = await f.conversations.append(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      { idempotencyKey: 'after-grant', body: 'Cobalt after the grant.' },
    );
    const later = await save(f, {
      ...f.command,
      messageId: source.messageId,
      expectedSourceEventId: source.eventId,
      idempotencyKey: 'save-later',
    });
    expect(
      (await f.app.inject({ url: `${future.path}/${old.id}`, headers: f.member.headers }))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.app.inject({ url: `${future.path}/${later.id}`, headers: f.member.headers }))
        .statusCode,
    ).toBe(200);
    for (const request of [
      { method: 'GET' as const, url: `${future.path}?limit=1` },
      {
        method: 'POST' as const,
        url: `${future.path}/search`,
        payload: { query: 'cobalt', limit: 1 },
      },
    ])
      expect(
        (await f.app.inject({ ...request, headers: f.member.headers })).json().memories,
      ).toMatchObject([{ id: later.id }]);
    await f.grants.remove(f.owner.user.id, f.owner.workspace.id, f.group.id, future.grant.id, {
      idempotencyKey: 'remove',
    });
    const replacement = await grantPath(f, { mode: 'all' });
    expect((await f.app.inject({ url: future.path, headers: f.member.headers })).statusCode).toBe(
      403,
    );
    expect(
      (await f.app.inject({ url: replacement.path, headers: f.member.headers })).json().memories,
    ).toHaveLength(2);
  });
  it('requires current human membership on every human and exact-grant read', async () => {
    const f = await memoryFixture(cleanup),
      memory = await save(f),
      bot = await grantPath(f, { mode: 'all' });
    const admin = await f.addUser('administrator');
    for (const path of [f.path, bot.path]) {
      expect(
        (await f.app.inject({ url: `${path}/${memory.id}`, headers: admin.headers })).statusCode,
      ).toBe(403);
      expect((await f.app.inject({ url: path, headers: admin.headers })).statusCode).toBe(403);
    }
    await f.groups.removeMember(f.owner.user.id, f.owner.workspace.id, f.group.id, f.member.id);
    for (const path of [f.path, bot.path]) {
      expect(
        (await f.app.inject({ url: `${path}/${memory.id}`, headers: f.member.headers })).statusCode,
      ).toBe(403);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${path}/search`,
            headers: f.member.headers,
            payload: { query: 'cobalt' },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path,
          headers: f.member.headers,
          payload: f.command,
        })
      ).statusCode,
    ).toBe(403);
    const audits = (
      await f.pool.query(
        "SELECT metadata FROM audit_events WHERE event_type='memory.access_denied'",
      )
    ).rows;
    expect(audits).toHaveLength(9);
    expect(JSON.stringify(audits)).not.toMatch(/cobalt|confidence|query|text/);
  });
  it('cannot list, search, read or save a source through a different group or workspace', async () => {
    const f = await memoryFixture(cleanup),
      memory = await save(f);
    const other = await f.groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Other scope',
    });
    const otherGrant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, other.id, {
      botId: f.bot.id,
      idempotencyKey: 'other',
      history: { mode: 'all' },
    });
    const otherPath = f.path.replace(f.group.id, other.id);
    for (const path of [
      otherPath,
      otherPath.replace('/memories', `/bots/${otherGrant.id}/memories`),
    ]) {
      expect((await f.app.inject({ url: path, headers: f.headers })).json().memories).toEqual([]);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${path}/search`,
            headers: f.headers,
            payload: { query: 'cobalt' },
          })
        ).json().memories,
      ).toEqual([]);
      expect(
        (await f.app.inject({ url: `${path}/${memory.id}`, headers: f.headers })).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: otherPath,
          headers: f.headers,
          payload: f.command,
        })
      ).statusCode,
    ).toBe(403);
    const workspaceId = randomUUID();
    await f.pool.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,$3)', [
      workspaceId,
      'Other workspace',
      new Date(),
    ]);
    const otherUser = await f.addUser('owner', workspaceId);
    expect(
      (
        await f.app.inject({
          url: f.path.replace(f.owner.workspace.id, workspaceId),
          headers: otherUser.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.app.inject({ url: `${f.path}/${memory.id}`, headers: otherUser.headers }))
        .statusCode,
    ).toBe(403);
  });
  it('rechecks the granting human authority and never substitutes another active grant', async () => {
    const f = await memoryFixture(cleanup),
      memory = await save(f);
    const grantor = await f.addUser();
    await f.groups.addMember(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      userId: grantor.id,
      role: 'admin',
    });
    const acl = `/api/v1/workspaces/${f.owner.workspace.id}/bots/${f.bot.id}/acl`;
    expect(
      (
        await f.aclApp.inject({
          method: 'POST',
          url: acl,
          headers: f.headers,
          payload: { userId: grantor.id },
        })
      ).statusCode,
    ).toBe(201);
    const grant = await f.grants.invite(grantor.id, f.owner.workspace.id, f.group.id, {
      botId: f.bot.id,
      idempotencyKey: 'delegated',
      history: { mode: 'all' },
    });
    const path = f.path.replace('/memories', `/bots/${grant.id}/memories`);
    expect(
      (await f.app.inject({ url: `${path}/${memory.id}`, headers: f.member.headers })).statusCode,
    ).toBe(200);
    expect(
      (await f.aclApp.inject({ method: 'DELETE', url: `${acl}/${grantor.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await f.app.inject({ url: `${path}/${memory.id}`, headers: f.headers })).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${path}/search`,
          headers: f.member.headers,
          payload: { query: 'cobalt' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.app.inject({ url: `${f.path}/${memory.id}`, headers: f.member.headers })).statusCode,
    ).toBe(200);
  });
  it('fails closed when a denial audit cannot be committed', async () => {
    const f = await memoryFixture(cleanup, {
      onMemoryQuery: (sql) => {
        if (sql.startsWith('INSERT INTO audit_events')) throw new Error('audit unavailable');
      },
    });
    const outsider = await f.addUser();
    const response = await f.app.inject({
      method: 'POST',
      url: `${f.path}/search`,
      headers: outsider.headers,
      payload: { query: 'never-log-this-query' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'memory_unavailable' } });
    expect((await f.pool.query('SELECT id FROM group_memories')).rows).toEqual([]);
    expect(
      (await f.pool.query("SELECT id FROM audit_events WHERE event_type='memory.access_denied'"))
        .rows,
    ).toEqual([]);
  });
  it('audits wrong-origin requests without storing their search body', async () => {
    const f = await memoryFixture(cleanup);
    const response = await f.app.inject({
      method: 'POST',
      url: `${f.path}/search`,
      headers: { ...f.headers, origin: 'https://different.example' },
      payload: { query: 'never-log-this-query' },
    });
    expect(response.statusCode).toBe(403);
    expect(
      (
        await f.pool.query(
          "SELECT metadata FROM audit_events WHERE event_type='memory.access_denied'",
        )
      ).rows,
    ).toEqual([
      { metadata: { operation: 'search', workspaceId: f.owner.workspace.id, groupId: f.group.id } },
    ]);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});

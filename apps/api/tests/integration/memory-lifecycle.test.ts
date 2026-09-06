import { afterEach, expect, it } from 'vitest';
import { memoryFixture } from '../helpers/memory-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('appends an immutable edit, forgets with a tombstone, and keeps forgotten text out of audits', async () => {
  const f = await memoryFixture(cleanup);
  const created = await f.app.inject({
    method: 'POST',
    url: f.path,
    headers: f.member.headers,
    payload: f.command,
  });
  expect(created.statusCode).toBe(201);
  const memory = created.json().memory;
  const firstVersionId = memory.versionId;
  const edited = await f.app.inject({
    method: 'POST',
    url: `${f.path}/${memory.id}/edits`,
    headers: f.member.headers,
    payload: { expectedVersionId: firstVersionId, body: 'The launch code is indigo.' },
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().memory).toMatchObject({
    id: memory.id,
    version: 2,
    text: 'The launch code is indigo.',
  });
  expect(edited.json().memory.versionId).not.toBe(firstVersionId);
  const versions = (await f.pool.query('SELECT version,kind,body FROM memory_revisions')).rows;
  expect(versions).toEqual([{ version: 2, kind: 'edit', body: 'The launch code is indigo.' }]);
  expect(
    (await f.pool.query('SELECT version FROM memory_versions WHERE memory_id=$1', [memory.id]))
      .rows,
  ).toEqual([{ version: 1 }]);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/search`,
        headers: f.member.headers,
        payload: { query: 'indigo' },
      })
    ).json().memories,
  ).toMatchObject([{ id: memory.id, version: 2 }]);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/${memory.id}/tombstones`,
        headers: f.member.headers,
        payload: { expectedVersionId: firstVersionId },
      })
    ).statusCode,
  ).toBe(409);
  const forgotten = await f.app.inject({
    method: 'POST',
    url: `${f.path}/${memory.id}/tombstones`,
    headers: f.member.headers,
    payload: { expectedVersionId: edited.json().memory.versionId },
  });
  expect(forgotten.json()).toEqual({ forgotten: true });
  expect(
    (await f.app.inject({ url: `${f.path}/${memory.id}`, headers: f.member.headers })).statusCode,
  ).toBe(403);
  expect((await f.app.inject({ url: f.path, headers: f.member.headers })).json().memories).toEqual(
    [],
  );
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/search`,
        headers: f.member.headers,
        payload: { query: 'indigo' },
      })
    ).json().memories,
  ).toEqual([]);
  await f.pool.query(
    `INSERT INTO memory_revisions(id,memory_id,version,kind,body,actor_user_id,created_at,previous_version_id)
     VALUES($1,$2,4,'edit',$3,$4,$5,$6)`,
    [
      '11111111-1111-4111-8111-111111111111',
      memory.id,
      'The launch code is indigo.',
      f.member.id,
      new Date(),
      edited.json().memory.versionId,
    ],
  );
  expect((await f.app.inject({ url: f.path, headers: f.member.headers })).json().memories).toEqual(
    [],
  );
  const audits = (
    await f.pool.query(
      "SELECT event_type,metadata FROM audit_events WHERE event_type IN ('memory.edited','memory.forgotten')",
    )
  ).rows;
  expect(audits).toHaveLength(2);
  expect(JSON.stringify(audits)).not.toMatch(/indigo|cobalt/i);
});

it('marks derived memories pending when the source is tombstoned and allows retain or revoke', async () => {
  const f = await memoryFixture(cleanup);
  const created = await f.app.inject({
    method: 'POST',
    url: f.path,
    headers: f.member.headers,
    payload: f.command,
  });
  const memory = created.json().memory;
  await f.conversations.tombstone(
    f.owner.user.id,
    f.owner.workspace.id,
    f.conversation.id,
    f.source.messageId,
    { idempotencyKey: 'forget-source', expectedVersion: 1, reason: 'Deleted by author' },
  );
  expect((await f.pool.query('SELECT action,reason FROM memory_revocation_events')).rows).toEqual([
    { action: 'pending', reason: 'source_tombstoned' },
  ]);
  expect((await f.app.inject({ url: f.path, headers: f.member.headers })).json().memories).toEqual(
    [],
  );
  expect(
    (await f.app.inject({ url: `${f.path}/${memory.id}`, headers: f.member.headers })).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${f.group.id}/pending-memory-revocations`,
        headers: f.member.headers,
      })
    ).json().pendingRevocations,
  ).toMatchObject([{ id: memory.id, text: 'The launch code is cobalt.' }]);
  const retained = await f.app.inject({
    method: 'POST',
    url: `${f.path}/${memory.id}/retentions`,
    headers: f.member.headers,
    payload: { expectedVersionId: memory.versionId, idempotencyKey: 'keep-fact' },
  });
  expect(retained.statusCode).toBe(200);
  expect(retained.json().memory.text).toBe('The launch code is cobalt.');
  expect(
    (await f.app.inject({ url: f.path, headers: f.member.headers })).json().memories,
  ).toMatchObject([{ id: memory.id, text: 'The launch code is cobalt.' }]);
  const other = await f.conversations.append(
    f.owner.user.id,
    f.owner.workspace.id,
    f.conversation.id,
    { idempotencyKey: 'second-source', body: 'Secondary fact stays scoped.' },
  );
  const second = await f.app.inject({
    method: 'POST',
    url: f.path,
    headers: f.member.headers,
    payload: {
      messageId: other.messageId,
      expectedSourceEventId: other.eventId,
      confidence: 0.5,
      idempotencyKey: 'save-second',
    },
  });
  expect(second.statusCode).toBe(201);
  await f.conversations.tombstone(
    f.owner.user.id,
    f.owner.workspace.id,
    f.conversation.id,
    other.messageId,
    { idempotencyKey: 'forget-second', expectedVersion: 1, reason: 'Deleted by author' },
  );
  const revoked = await f.app.inject({
    method: 'POST',
    url: `${f.path}/${second.json().memory.id}/revocations`,
    headers: f.member.headers,
    payload: { expectedVersionId: second.json().memory.versionId, idempotencyKey: 'drop-fact' },
  });
  expect(revoked.json()).toEqual({ revoked: true });
  expect(
    (await f.app.inject({ url: f.path, headers: f.member.headers })).json().memories,
  ).toMatchObject([{ id: memory.id }]);
  expect(
    JSON.stringify(
      (
        await f.pool.query(
          "SELECT event_type,metadata FROM audit_events WHERE event_type IN ('memory.retained','memory.revoked')",
        )
      ).rows,
    ),
  ).not.toMatch(/cobalt|Secondary/i);
});

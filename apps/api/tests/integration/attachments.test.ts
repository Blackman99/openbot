import type { ObjectStore } from '../../src/objects/store.js';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { objectOperation } from '../../src/objects/operation.js';
import { barrier } from '../helpers/barrier.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { buildApp } from '../../src/app.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';

const token = Buffer.alloc(32, 47).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };
const bytes = Buffer.from('Quarterly notes\nNo knowledge promotion.\n');
const metadata = {
  idempotencyKey: 'attach-1',
  body: 'Read these notes',
  filename: 'notes.txt',
  mediaType: 'text/plain',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  options: {
    store?: (store: ObjectStore) => ObjectStore;
    onQuery?: (statement: string) => void;
    now?: () => Date;
  } = {},
) {
  const db = newDb({ noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  cleanup.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$attachments-test',
    generateSessionToken: () => token,
  });
  const owner = await auth.setup({
    displayName: 'Ada',
    email: 'ada@example.com',
    password: 'correct horse battery staple',
  });
  const groups = new GroupService(new PostgresGroupRepository(pool));
  const group = await groups.create(owner.user.id, owner.workspace.id, { name: 'Attachments' });
  const conversations = new ConversationService(new PostgresConversationRepository(pool));
  const conversation = await conversations.open(owner.user.id, owner.workspace.id, {
    subject: { kind: 'group', id: group.id },
  });
  const root = await mkdtemp(join(tmpdir(), 'openbot-attachments-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const attachmentPool: SqlPool = {
    connect: async () => {
      const connection = await pool.connect();
      let backup: ReturnType<typeof db.backup> | undefined;
      return {
        query: async (statement, parameters) => {
          if (statement === 'BEGIN') backup = db.backup();
          if (statement === 'ROLLBACK') backup?.restore();
          options.onQuery?.(statement);
          if (statement === 'SELECT purge_conversation_message($1,$2,$3)')
            return connection.query(
              'UPDATE conversation_events SET body=NULL,reason=NULL,command_hash=$3 WHERE conversation_id=$1 AND message_id=$2',
              [parameters![1], parameters![2], '0'.repeat(64)],
            );
          return connection.query(statement, parameters);
        },
        release: () => connection.release(),
      };
    },
  };
  const local = new LocalObjectStore(root, { maxObjectBytes: 10 * 1024 * 1024 });
  const store = options.store?.(local) ?? local;
  const attachments = new AttachmentService(attachmentPool, store, undefined, options.now);
  const app = buildApp({
    auth,
    groups,
    conversations,
    attachments,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  const base = `/api/v1/workspaces/${owner.workspace.id}/conversations/${conversation.id}`;
  return { app, pool, owner, group, conversation, base, attachments, store, attachmentPool };
}
function envelope(command: unknown, content: Buffer) {
  const metadata = Buffer.from(JSON.stringify(command)),
    size = Buffer.alloc(4);
  size.writeUInt32BE(metadata.length);
  return Buffer.concat([size, metadata, content]);
}
async function publish(
  f: Awaited<ReturnType<typeof fixture>>,
  command = metadata,
  content = bytes,
) {
  return f.app.inject({
    method: 'POST',
    url: f.base + '/attachments',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: envelope(command, content),
  });
}
describe('conversation-local attachments', () => {
  it('atomically publishes one attachment and message and privately reloads and downloads it', async () => {
    const { app, base, pool } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: `${base}/attachments`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: envelope(metadata, bytes),
    });
    expect(result.statusCode).toBe(200);
    const receipt = result.json().receipt;
    expect(receipt).toEqual({
      messageId: expect.any(String),
      eventId: expect.any(String),
      sequence: 1,
    });
    const page = await app.inject({ url: base, headers });
    expect(page.json().messages).toMatchObject([
      {
        id: receipt.messageId,
        body: metadata.body,
        attachment: {
          id: expect.any(String),
          filename: 'notes.txt',
          mediaType: 'text/plain',
          bytes: bytes.length,
        },
      },
    ]);
    const download = await app.inject({
      url: `${base}/messages/${receipt.messageId}/attachment/content`,
      headers,
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(bytes);
    const stored = (await pool.query('SELECT storage_id AS id FROM attachment_objects')).rows[0]!;
    expect(page.body).not.toContain(stored.id);

    expect(download.headers).toMatchObject({
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'attachment; filename="notes.txt"; filename*=UTF-8\'\'notes.txt',
    });
  });
  it('purges original and registered derivatives, denies reads immediately, and retries unavailable storage after reconstruction', async () => {
    let unavailable = true,
      clock = new Date();
    const f = await fixture({
      now: () => clock,
      store: (local) => ({
        identity: local.identity,
        save: (...args) => local.save(...args),
        read: (...args) => local.read(...args),
        delete: async (...args) => {
          if (unavailable) throw new Error('offline');
          await local.delete(...args);
        },
      }),
    });
    const { app, base, attachments, pool, owner, conversation } = f;
    const upload = await publish(f);
    expect(upload.statusCode).toBe(200);
    const receipt = upload.json().receipt;
    const access = {
      actorUserId: owner.user.id,
      workspaceId: owner.workspace.id,
      conversationId: conversation.id,
    };
    await attachments.registerDerived(
      access,
      receipt.messageId,
      { ...metadata, filename: 'derived.txt' },
      bytes,
    );
    const purged = await app.inject({
      method: 'POST',
      url: `${base}/messages/${receipt.messageId}/purge`,
      headers,
      payload: {},
    });
    expect(purged.statusCode).toBe(202);
    expect(
      (
        await app.inject({
          url: `${base}/messages/${receipt.messageId}/attachment/content`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `${base}/messages/${receipt.messageId}/versions`, headers }))
        .statusCode,
    ).toBe(403);
    expect(await attachments.cleanup()).toEqual({ deleted: 0, retried: 2 });
    expect((await pool.query('SELECT filename FROM attachment_objects')).rows).toEqual(
      expect.arrayContaining([{ filename: 'notes.txt' }, { filename: 'derived.txt' }]),
    );
    unavailable = false;
    clock = new Date(clock.getTime() + 60001);
    const restarted = new AttachmentService(f.attachmentPool, f.store, undefined, () => clock);
    expect(await restarted.cleanup()).toEqual({ deleted: 2, retried: 0 });
    const done = await app.inject({
      method: 'POST',
      url: `${base}/messages/${receipt.messageId}/purge`,
      headers,
      payload: {},
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ purge: { state: 'complete' } });
    expect((await pool.query('SELECT filename,sha256 FROM attachment_objects')).rows).toEqual([
      { filename: null, sha256: null },
      { filename: null, sha256: null },
    ]);
    expect(
      (
        await pool.query('SELECT body,reason FROM conversation_events WHERE message_id=$1', [
          receipt.messageId,
        ])
      ).rows.every(
        (row: { body: unknown; reason: unknown }) => row.body === null && row.reason === null,
      ),
    ).toBe(true);
    expect((await publish(f)).statusCode).toBe(409);
    expect((await app.inject({ url: base, headers })).json().messages).toMatchObject([
      { body: null, reason: 'Message purged', deleted: true, canAudit: false },
    ]);
    const audits = (
      await pool.query(
        "SELECT metadata FROM audit_events WHERE event_type='conversation.message_purged'",
      )
    ).rows;
    expect(audits).toEqual([
      {
        metadata: {
          workspaceId: owner.workspace.id,
          conversationId: conversation.id,
          messageId: receipt.messageId,
        },
      },
    ]);
  });
  it('completes a ready message purge while an older object deletion remains unavailable', async () => {
    let clock = new Date(),
      blockedObject = '';
    const f = await fixture({
      now: () => clock,
      store: (local) => ({
        identity: local.identity,
        save: (...args) => local.save(...args),
        read: (...args) => local.read(...args),
        delete: async (key) => {
          if (key.objectId === blockedObject) throw new Error('unavailable object');
          await local.delete(key);
        },
      }),
    });
    const access = {
      actorUserId: f.owner.user.id,
      workspaceId: f.owner.workspace.id,
      conversationId: f.conversation.id,
    };
    const older = await f.attachments.upload(access, metadata, bytes);
    const later = await f.attachments.upload(
      access,
      { ...metadata, idempotencyKey: 'later' },
      bytes,
    );
    blockedObject = (
      await f.pool.query('SELECT storage_id FROM attachment_objects WHERE message_id=$1', [
        older.messageId,
      ])
    ).rows[0]!.storage_id;
    await f.attachments.purge(access, older.messageId);
    clock = new Date(clock.getTime() + 1000);
    await f.attachments.purge(access, later.messageId);
    expect(await f.attachments.cleanup(1)).toEqual({ deleted: 0, retried: 1 });
    expect(await f.attachments.cleanup(1)).toEqual({ deleted: 1, retried: 0 });
    expect(await f.attachments.purge(access, later.messageId)).toEqual({ state: 'complete' });
    expect(await f.attachments.purge(access, older.messageId)).toEqual({ state: 'purging' });
    expect(
      (await f.pool.query('SELECT body FROM conversation_events WHERE id=$1', [later.eventId]))
        .rows,
    ).toEqual([{ body: null }]);
    expect(
      (await f.pool.query('SELECT body FROM conversation_events WHERE id=$1', [older.eventId]))
        .rows,
    ).toEqual([{ body: metadata.body }]);
    blockedObject = '';
    clock = new Date(clock.getTime() + 60001);
    await f.attachments.cleanup(1);
    expect(await f.attachments.purge(access, older.messageId)).toEqual({ state: 'complete' });
  });
  it('keeps an in-flight derivative lease until its write settles before completing purge', async () => {
    const started = barrier(),
      release = barrier();
    let pause = false;
    const f = await fixture({
      store: (local) => ({
        identity: local.identity,
        save: async (...args) => {
          if (pause) {
            started.resolve();
            await release.promise;
          }
          await local.save(...args);
        },
        read: (...args) => local.read(...args),
        delete: (...args) => local.delete(...args),
      }),
    });
    const access = {
      actorUserId: f.owner.user.id,
      workspaceId: f.owner.workspace.id,
      conversationId: f.conversation.id,
    };
    const receipt = await f.attachments.upload(access, metadata, bytes);
    pause = true;
    const derived = f.attachments
      .registerDerived(access, receipt.messageId, { ...metadata, filename: 'derived.txt' }, bytes)
      .then(
        () => 'published',
        () => 'rejected',
      );
    try {
      await started.promise;
      await f.attachments.purge(access, receipt.messageId);
      expect(await f.attachments.cleanup()).toEqual({ deleted: 1, retried: 0 });
      expect(await f.attachments.purge(access, receipt.messageId)).toEqual({ state: 'purging' });
    } finally {
      release.resolve();
      await derived;
    }
    expect(await derived).toBe('rejected');
    expect(await f.attachments.cleanup()).toEqual({ deleted: 1, retried: 0 });
    expect(await f.attachments.purge(access, receipt.messageId)).toEqual({ state: 'complete' });
    const objects = (await f.pool.query('SELECT storage_id FROM attachment_objects')).rows;
    for (const object of objects)
      await expect(
        f.store.read(
          { workspaceId: access.workspaceId, objectId: object.storage_id },
          bytes.length,
        ),
      ).rejects.toThrow();
  });
  it('preserves the reconciliation lease when a timed-out adapter still has a background write', async () => {
    const release = barrier(),
      written = barrier();
    let late = false,
      clock = new Date();
    const f = await fixture({
      now: () => clock,
      store: (local) => ({
        identity: local.identity,
        save: async (...args) => {
          if (!late) return local.save(...args);
          return objectOperation(5, undefined, async () => {
            await release.promise;
            await local.save(...args);
            written.resolve();
          });
        },
        read: (...args) => local.read(...args),
        delete: (...args) => local.delete(...args),
      }),
    });
    const access = {
      actorUserId: f.owner.user.id,
      workspaceId: f.owner.workspace.id,
      conversationId: f.conversation.id,
    };
    const receipt = await f.attachments.upload(access, metadata, bytes);
    late = true;
    await expect(
      f.attachments.registerDerived(
        access,
        receipt.messageId,
        { ...metadata, filename: 'derived.txt' },
        bytes,
      ),
    ).rejects.toThrow();
    try {
      await f.attachments.purge(access, receipt.messageId);
      expect(await f.attachments.cleanup()).toEqual({ deleted: 1, retried: 0 });
      expect(await f.attachments.purge(access, receipt.messageId)).toEqual({ state: 'purging' });
    } finally {
      release.resolve();
      await written.promise;
    }
    expect(await f.attachments.cleanup()).toEqual({ deleted: 0, retried: 0 });
    clock = new Date(clock.getTime() + 60001);
    expect(await f.attachments.cleanup()).toEqual({ deleted: 1, retried: 0 });
    expect(await f.attachments.purge(access, receipt.messageId)).toEqual({ state: 'complete' });
  });
  it('replays unchanged content once, conflicts on changed fingerprints, and isolates two workspaces during purge', async () => {
    const f = await fixture();
    const first = await publish(f);
    expect(first.statusCode).toBe(200);
    expect((await publish(f)).json()).toEqual(first.json());
    for (const changed of [
      { ...metadata, body: 'Changed' },
      { ...metadata, filename: 'renamed.txt' },
    ])
      expect((await publish(f, changed)).statusCode).toBe(409);
    expect(
      (await f.pool.query("SELECT id FROM attachment_objects WHERE state='live'")).rows,
    ).toHaveLength(1);
    const otherWorkspace = randomUUID();
    await f.pool.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
      otherWorkspace,
      'Neighbor',
    ]);
    await f.pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'owner',NOW())",
      [otherWorkspace, f.owner.user.id],
    );
    const group = await new GroupService(new PostgresGroupRepository(f.pool)).create(
      f.owner.user.id,
      otherWorkspace,
      { name: 'Neighbor' },
    );
    const other = await new ConversationService(new PostgresConversationRepository(f.pool)).open(
      f.owner.user.id,
      otherWorkspace,
      { subject: { kind: 'group', id: group.id } },
    );
    const access = {
      actorUserId: f.owner.user.id,
      workspaceId: otherWorkspace,
      conversationId: other.id,
    };
    const neighbor = await f.attachments.upload(
      access,
      { ...metadata, idempotencyKey: 'neighbor' },
      bytes,
    );
    const messageId = first.json().receipt.messageId;
    await f.attachments.purge(
      {
        actorUserId: f.owner.user.id,
        workspaceId: f.owner.workspace.id,
        conversationId: f.conversation.id,
      },
      messageId,
    );
    await f.attachments.cleanup();
    expect((await f.attachments.read(access, neighbor.messageId)).bytes).toEqual(bytes);
    await expect(
      f.attachments.read({ ...access, workspaceId: f.owner.workspace.id }, neighbor.messageId),
    ).rejects.toThrow();
  });
  it('rolls back publication and audit failure, retains cleanup intent, and recovers after a worker restart', async () => {
    let failAudit = false;
    const f = await fixture({
      onQuery: (statement) => {
        if (failAudit && statement.startsWith('INSERT INTO audit_events'))
          throw new Error('private database diagnostic');
      },
    });
    failAudit = true;
    const response = await publish(f);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private database diagnostic');
    expect((await f.pool.query('SELECT id FROM conversation_events')).rows).toHaveLength(0);
    expect((await f.pool.query('SELECT state FROM attachment_objects')).rows).toEqual([
      { state: 'staged' },
    ]);
    failAudit = false;
    const restarted = new AttachmentService(f.attachmentPool, f.store);
    expect(await restarted.cleanup()).toEqual({ deleted: 1, retried: 0 });
    expect((await f.pool.query('SELECT filename,sha256 FROM attachment_objects')).rows).toEqual([
      { filename: null, sha256: null },
    ]);
  });
  it('cleans an interrupted durable PUT and rechecks current permission after storage reads', async () => {
    const controller = new AbortController();
    let interrupt = true,
      revokeRead = false;
    const f = await fixture({
      store: (local) => ({
        identity: local.identity,
        save: async (...args) => {
          await local.save(...args);
          if (interrupt) controller.abort();
        },
        read: async (...args) => {
          const content = await local.read(...args);
          if (revokeRead)
            await f.pool.query('DELETE FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
              f.group.id,
              f.owner.user.id,
            ]);
          return content;
        },
        delete: (...args) => local.delete(...args),
      }),
    });
    const access = {
      actorUserId: f.owner.user.id,
      workspaceId: f.owner.workspace.id,
      conversationId: f.conversation.id,
    };
    await expect(
      f.attachments.upload(access, metadata, bytes, controller.signal),
    ).rejects.toThrow();
    expect((await f.pool.query('SELECT id FROM conversation_events')).rows).toHaveLength(0);
    expect(await f.attachments.cleanup()).toEqual({ deleted: 1, retried: 0 });
    interrupt = false;
    const receipt = await f.attachments.upload(access, metadata, bytes);
    revokeRead = true;
    await expect(f.attachments.read(access, receipt.messageId)).rejects.toThrow();
  });
  it('rejects oversized, mismatched, checksum-invalid and interrupted envelopes before any object intent', async () => {
    const f = await fixture();
    for (const [command, content] of [
      [{ ...metadata, bytes: 10485761 }, bytes],
      [{ ...metadata, mediaType: 'image/png' }, bytes],
      [{ ...metadata, sha256: '0'.repeat(64) }, bytes],
      [{ ...metadata, filename: 'bad.html', mediaType: 'text/html' }, bytes],
      [metadata, bytes.subarray(0, -1)],
    ] as const)
      expect((await publish(f, command, content)).statusCode).toBe(400);
    expect((await f.pool.query('SELECT id FROM attachment_objects')).rows).toHaveLength(0);
  });
});

import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { barrier } from '../helpers/barrier.js';
const databaseUrl = process.env.TEST_ATTACHMENT_DATABASE_URL;
describe.skipIf(!databaseUrl)('attachment PostgreSQL authority, publication and purge', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let runtime: pg.Pool, root: string;
  beforeAll(async () => {
    await migrateDatabase(admin);
    const url = new URL(databaseUrl!),
      password = `ci-attachments-${randomBytes(24).toString('hex')}`;
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../../../infra/postgres/grant-runtime-privileges.mjs', import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          PGHOST: url.hostname,
          PGPORT: url.port || '5432',
          PGDATABASE: url.pathname.slice(1),
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          OPENBOT_DATABASE_PASSWORD: password,
        },
      },
    );
    url.username = 'openbot_runtime';
    url.password = password;
    runtime = new pg.Pool({ connectionString: url.toString(), statement_timeout: 15000 });
    root = await mkdtemp(join(tmpdir(), 'openbot-native-attachments-'));
  });
  afterAll(async () => {
    await runtime?.end();
    await admin.end();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const actorUserId = randomUUID(),
      workspaceId = randomUUID();
    await runtime.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
      [actorUserId, `${actorUserId}@example.com`, 'Attachment author'],
    );
    await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
      workspaceId,
      'Files',
    ]);
    await runtime.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'owner',NOW())",
      [workspaceId, actorUserId],
    );
    const group = await new GroupService(new PostgresGroupRepository(runtime)).create(
      actorUserId,
      workspaceId,
      { name: 'Files' },
    );
    const conversations = new ConversationService(new PostgresConversationRepository(runtime));
    const conversation = await conversations.open(actorUserId, workspaceId, {
      subject: { kind: 'group', id: group.id },
    });
    const store = new LocalObjectStore(root, { maxObjectBytes: 10485760 });
    const service = new AttachmentService(runtime, store);
    const access = { actorUserId, workspaceId, conversationId: conversation.id };
    const bytes = Buffer.from('Native private file'),
      command = {
        body: 'Native file message',
        filename: 'private.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        idempotencyKey: 'upload',
      };
    return { access, store, service, bytes, command, conversations, group };
  }
  it('publishes one message under concurrent same-key attempts and fences every unused staged object', async () => {
    const f = await fixture();
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => f.service.upload(f.access, f.command, f.bytes)),
    );
    expect(receipts.every((r) => r.messageId === receipts[0]!.messageId)).toBe(true);
    expect(
      (
        await admin.query('SELECT id FROM conversation_events WHERE conversation_id=$1', [
          f.access.conversationId,
        ])
      ).rows,
    ).toHaveLength(1);
    await f.service.cleanup(100);
    expect(
      (
        await admin.query(
          "SELECT id FROM attachment_objects WHERE conversation_id=$1 AND state='live'",
          [f.access.conversationId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await new AttachmentService(runtime, f.store).read(f.access, receipts[0]!.messageId)).bytes,
    ).toEqual(f.bytes);
  });
  it('rolls back sequence, reference and audit together while retaining the earlier durable intent', async () => {
    const f = await fixture();
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(f.service.upload(f.access, f.command, f.bytes)).rejects.toThrow();
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(
      (
        await admin.query('SELECT last_sequence FROM conversations WHERE id=$1', [
          f.access.conversationId,
        ])
      ).rows,
    ).toEqual([{ last_sequence: '0' }]);
    expect(
      (
        await admin.query('SELECT id FROM conversation_events WHERE conversation_id=$1', [
          f.access.conversationId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await admin.query('SELECT state FROM attachment_objects WHERE conversation_id=$1', [
          f.access.conversationId,
        ])
      ).rows,
    ).toEqual([{ state: 'staged' }]);
    await f.service.cleanup(100);
    expect(
      (
        await admin.query(
          'SELECT state,filename,sha256 FROM attachment_objects WHERE conversation_id=$1',
          [f.access.conversationId],
        )
      ).rows,
    ).toEqual([{ state: 'deleted', filename: null, sha256: null }]);
  });
  it('removes original and derived bytes and all message content while preserving identity, isolation, audit and no replay resurrection', async () => {
    const f = await fixture(),
      neighbor = await fixture();
    const receipt = await f.service.upload(f.access, f.command, f.bytes);
    await f.service.registerDerived(
      f.access,
      receipt.messageId,
      { ...f.command, filename: 'derived.txt' },
      f.bytes,
    );
    const retained = await neighbor.service.upload(
      neighbor.access,
      neighbor.command,
      neighbor.bytes,
    );
    const identities = (
      await admin.query(
        'SELECT id,sequence,actor_user_id FROM conversation_events WHERE conversation_id=$1',
        [f.access.conversationId],
      )
    ).rows;
    const objects = (
      await admin.query('SELECT id,storage_id FROM attachment_objects WHERE conversation_id=$1', [
        f.access.conversationId,
      ])
    ).rows;
    await expect(
      runtime.query('SELECT purge_conversation_message($1,$2,$3)', [
        f.access.workspaceId,
        f.access.conversationId,
        receipt.messageId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      runtime.query('UPDATE conversation_events SET body=NULL WHERE id=$1', [receipt.eventId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query('UPDATE attachment_objects SET workspace_id=$2 WHERE id=$1', [
        objects[0]!.id,
        neighbor.access.workspaceId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await f.service.purge(f.access, receipt.messageId)).toEqual({ state: 'purging' });
    await expect(f.service.read(f.access, receipt.messageId)).rejects.toThrow();
    await expect(
      f.conversations.versions(
        f.access.actorUserId,
        f.access.workspaceId,
        f.access.conversationId,
        receipt.messageId,
      ),
    ).rejects.toThrow();
    await f.service.cleanup(100);
    expect(await f.service.purge(f.access, receipt.messageId)).toEqual({ state: 'complete' });
    expect(
      (
        await admin.query(
          'SELECT body,reason,command_hash FROM conversation_events WHERE conversation_id=$1',
          [f.access.conversationId],
        )
      ).rows,
    ).toEqual([
      { body: null, reason: null, command_hash: '0'.repeat(64) },
      { body: null, reason: null, command_hash: '0'.repeat(64) },
    ]);
    expect(
      (
        await admin.query('SELECT id,sequence,actor_user_id FROM conversation_events WHERE id=$1', [
          receipt.eventId,
        ])
      ).rows,
    ).toEqual(identities);
    for (const object of objects)
      await expect(
        f.store.read({ workspaceId: f.access.workspaceId, objectId: object.storage_id }, 100),
      ).rejects.toThrow();
    expect((await neighbor.service.read(neighbor.access, retained.messageId)).bytes).toEqual(
      neighbor.bytes,
    );
    await expect(f.service.upload(f.access, f.command, f.bytes)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(
      (
        await admin.query(
          "SELECT metadata FROM audit_events WHERE event_type='conversation.message_purged' AND metadata->>'messageId'=$1",
          [receipt.messageId],
        )
      ).rows,
    ).toEqual([
      {
        metadata: {
          workspaceId: f.access.workspaceId,
          conversationId: f.access.conversationId,
          messageId: receipt.messageId,
        },
      },
    ]);
  });
  it('preserves the staged derivative lease during purge and completes only after settled-write cleanup', async () => {
    const f = await fixture(),
      receipt = await f.service.upload(f.access, f.command, f.bytes);
    const started = barrier(),
      release = barrier();
    const service = new AttachmentService(runtime, {
      identity: f.store.identity,
      save: async (...args) => {
        started.resolve();
        await release.promise;
        await f.store.save(...args);
      },
      read: (...args) => f.store.read(...args),
      delete: (...args) => f.store.delete(...args),
    });
    const derived = service
      .registerDerived(
        f.access,
        receipt.messageId,
        { ...f.command, filename: 'derived.txt' },
        f.bytes,
      )
      .then(
        () => 'published',
        () => 'rejected',
      );
    try {
      await started.promise;
      await service.purge(f.access, receipt.messageId);
      expect(await service.cleanup(100)).toEqual({ deleted: 1, retried: 0 });
      expect(await service.purge(f.access, receipt.messageId)).toEqual({ state: 'purging' });
    } finally {
      release.resolve();
      await derived;
    }
    expect(await derived).toBe('rejected');
    expect(await service.cleanup(100)).toEqual({ deleted: 1, retried: 0 });
    expect(await service.purge(f.access, receipt.messageId)).toEqual({ state: 'complete' });
  });
  it('rolls back purge request and final redaction when their mandatory audits fail', async () => {
    const f = await fixture(),
      receipt = await f.service.upload(f.access, f.command, f.bytes);
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(f.service.purge(f.access, receipt.messageId)).rejects.toThrow();
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect((await f.service.read(f.access, receipt.messageId)).bytes).toEqual(f.bytes);
    expect(
      (
        await admin.query('SELECT state FROM message_purges WHERE conversation_id=$1', [
          f.access.conversationId,
        ])
      ).rows,
    ).toHaveLength(0);
    await f.service.purge(f.access, receipt.messageId);
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(f.service.cleanup(100)).rejects.toThrow();
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(
      (await admin.query('SELECT body FROM conversation_events WHERE id=$1', [receipt.eventId]))
        .rows,
    ).toEqual([{ body: f.command.body }]);
    expect(
      (
        await admin.query('SELECT state FROM message_purges WHERE conversation_id=$1', [
          f.access.conversationId,
        ])
      ).rows,
    ).toEqual([{ state: 'purging' }]);
    await new AttachmentService(runtime, f.store).cleanup(100);
    expect(
      (await admin.query('SELECT body FROM conversation_events WHERE id=$1', [receipt.eventId]))
        .rows,
    ).toEqual([{ body: null }]);
  });
});

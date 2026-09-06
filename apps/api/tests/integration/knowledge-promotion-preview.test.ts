import type { ObjectStore } from '../../src/objects/store.js';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { newMemDatabase } from '../helpers/provider-database.js';
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
const bytes = Buffer.from('Quarterly notes\nKeep the cobalt key\n');
const metadata = {
  idempotencyKey: 'attach-knowledge-1',
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

async function fixture() {
  const db = newMemDatabase();
  const pool = new (db.adapters.createPg().Pool)();
  cleanup.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$knowledge-test',
    generateSessionToken: () => token,
  });
  const owner = await auth.setup({
    displayName: 'Ada',
    email: 'ada@example.com',
    password: 'correct horse battery staple',
  });
  const groups = new GroupService(new PostgresGroupRepository(pool));
  const group = await groups.create(owner.user.id, owner.workspace.id, { name: 'Knowledge' });
  const conversations = new ConversationService(new PostgresConversationRepository(pool));
  const conversation = await conversations.open(owner.user.id, owner.workspace.id, {
    subject: { kind: 'group', id: group.id },
  });
  const root = await mkdtemp(join(tmpdir(), 'openbot-knowledge-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const attachmentPool: SqlPool = {
    connect: async () => {
      const connection = await pool.connect();
      let backup: ReturnType<typeof db.backup> | undefined;
      return {
        query: async (statement, parameters) => {
          if (statement === 'BEGIN') backup = db.backup();
          if (statement === 'ROLLBACK') backup?.restore();
          return connection.query(statement, parameters);
        },
        release: () => connection.release(),
      };
    },
  };
  const store: ObjectStore = new LocalObjectStore(root, { maxObjectBytes: 10 * 1024 * 1024 });
  const attachments = new AttachmentService(attachmentPool, store);
  const knowledge = new KnowledgeService(attachmentPool, attachments);
  const app = buildApp({
    auth,
    groups,
    conversations,
    attachments,
    knowledge,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  const base = `/api/v1/workspaces/${owner.workspace.id}/conversations/${conversation.id}`;
  return { app, pool, base, owner, group };
}

function envelope(command: unknown, content: Buffer) {
  const json = Buffer.from(JSON.stringify(command));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, content]);
}

describe('KNW-01 text-like promotion preview', () => {
  it('does not persist knowledge on upload or extraction preview', async () => {
    const { app, pool, base } = await fixture();
    const uploaded = await app.inject({
      method: 'POST',
      url: `${base}/attachments`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: envelope(metadata, bytes),
    });
    expect(uploaded.statusCode).toBe(200);
    const messageId = uploaded.json().receipt.messageId as string;
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM knowledge_chunks')).rows).toEqual([]);
    const preview = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/preview`,
      headers,
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      preview: {
        source: {
          attachmentId: expect.any(String),
          messageId,
          filename: 'notes.txt',
          mediaType: 'text/plain',
          fileVersion: 1,
        },
        kind: 'txt',
        chunks: [
          {
            text: 'Quarterly notes',
            fileVersion: 1,
            locator: { kind: 'line', start: 1, end: 1 },
          },
          {
            text: 'Keep the cobalt key',
            fileVersion: 1,
            locator: { kind: 'line', start: 2, end: 2 },
          },
        ],
      },
    });
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM knowledge_chunks')).rows).toEqual([]);
  });

  it('writes scoped knowledge only after an authorized confirmation of an explicit destination', async () => {
    const { app, pool, base, owner, group } = await fixture();
    const uploaded = await app.inject({
      method: 'POST',
      url: `${base}/attachments`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: envelope(metadata, bytes),
    });
    const messageId = uploaded.json().receipt.messageId as string;
    const preview = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/preview`,
      headers,
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/messages/${messageId}/knowledge/promotions`,
          headers,
          payload: {
            destination: { kind: 'group', id: group.id },
            idempotencyKey: 'promote-notes',
            acknowledged: false,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    const confirmed = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/promotions`,
      headers,
      payload: {
        destination: { kind: 'group', id: group.id },
        idempotencyKey: 'promote-notes',
        acknowledged: true,
      },
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json()).toMatchObject({
      document: {
        scope: { kind: 'group', id: group.id, workspaceId: owner.workspace.id },
        source: {
          messageId,
          filename: 'notes.txt',
          fileVersion: 1,
        },
        chunkCount: 2,
        approver: { id: owner.user.id },
        replayed: false,
      },
    });
    expect((await pool.query('SELECT scope_kind,scope_id FROM knowledge_documents')).rows).toEqual([
      { scope_kind: 'group', scope_id: group.id },
    ]);
    expect(
      (
        await pool.query(
          'SELECT position,locator_kind,locator_start,text FROM knowledge_chunks ORDER BY position',
        )
      ).rows,
    ).toEqual([
      { position: 1, locator_kind: 'line', locator_start: 1, text: 'Quarterly notes' },
      { position: 2, locator_kind: 'line', locator_start: 2, text: 'Keep the cobalt key' },
    ]);
    const replay = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/promotions`,
      headers,
      payload: {
        destination: { kind: 'group', id: group.id },
        idempotencyKey: 'promote-notes',
        acknowledged: true,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().document.id).toBe(confirmed.json().document.id);
    expect(replay.json().document.replayed).toBe(true);
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toHaveLength(1);
    const outsiderId = '11111111-1111-4111-8111-111111111111';
    const outsiderToken = Buffer.alloc(32, 48).toString('base64url');
    await pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
      [outsiderId, 'outsider@example.com', 'Outsider'],
    );
    await pool.query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
      [owner.workspace.id, outsiderId, 'member'],
    );
    await new PostgresAuthRepository(pool).createSession({
      userId: outsiderId,
      tokenDigest: createHash('sha256').update(outsiderToken).digest('hex'),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
      auditId: '22222222-2222-4222-8222-222222222222',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/messages/${messageId}/knowledge/promotions`,
          headers: {
            cookie: `openbot_session=${outsiderToken}`,
            origin: 'http://localhost:3000',
          },
          payload: {
            destination: { kind: 'group', id: group.id },
            idempotencyKey: 'outsider-promote',
            acknowledged: true,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toHaveLength(1);
  });
});

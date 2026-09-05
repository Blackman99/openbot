import type { ObjectStore } from '../../src/objects/store.js';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { KnowledgeAccessError } from '../../src/knowledge/types.js';
import { TEXT_KNOWLEDGE_EXTRACTOR_VERSION } from '../../src/knowledge/text-extractor.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

async function fixture(now?: () => Date) {
  const db = newDb({ noAstCoverageCheck: true });
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
  const knowledge = new KnowledgeService(attachmentPool, attachments, now);
  const app = buildApp({
    auth,
    groups,
    conversations,
    attachments,
    knowledge,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  async function addUser(role: 'owner' | 'administrator' | 'member' = 'member') {
    const id = randomUUID(),
      session = randomBytes(32).toString('base64url'),
      created = new Date();
    await pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,$4)',
      [id, `${id}@example.com`, 'Workspace member', created],
    );
    await pool.query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4)',
      [owner.workspace.id, id, role, created],
    );
    await new PostgresAuthRepository(pool).createSession({
      userId: id,
      tokenDigest: createHash('sha256').update(session).digest('hex'),
      createdAt: created,
      expiresAt: new Date(created.getTime() + 3600000),
      auditId: randomUUID(),
    });
    return {
      id,
      headers: { ...headers, cookie: `openbot_session=${session}` },
    };
  }
  const base = `/api/v1/workspaces/${owner.workspace.id}/conversations/${conversation.id}`;
  return {
    app,
    pool,
    base,
    group,
    owner,
    groups,
    addUser,
    knowledge,
    knowledgePool: attachmentPool,
    attachments,
    conversation,
  };
}

function envelope(command: unknown, content: Buffer) {
  const json = Buffer.from(JSON.stringify(command));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, content]);
}

const extractedChunks = [
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
];

async function uploadedMessage(app: Awaited<ReturnType<typeof fixture>>['app'], base: string) {
  const uploaded = await app.inject({
    method: 'POST',
    url: `${base}/attachments`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: envelope(metadata, bytes),
  });
  expect(uploaded.statusCode).toBe(200);
  return uploaded.json().receipt.messageId as string;
}

describe('KNW-01 text-like promotion preview', () => {
  it('does not persist knowledge on upload or extraction preview', async () => {
    const { app, pool, base } = await fixture();
    const messageId = await uploadedMessage(app, base);
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
        chunks: extractedChunks,
      },
    });
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM knowledge_chunks')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM knowledge_promotion_intents')).rows).toEqual([]);
  });

  it('binds a scoped preview intent without writing knowledge documents or chunks', async () => {
    const { app, pool, base, group } = await fixture();
    const messageId = await uploadedMessage(app, base);
    const preview = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/preview`,
      headers,
      payload: { scope: { kind: 'group', id: group.id } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      preview: {
        id: expect.any(String),
        expiresAt: expect.any(String),
        scope: { kind: 'group', id: group.id },
        source: {
          attachmentId: expect.any(String),
          messageId,
          filename: 'notes.txt',
          mediaType: 'text/plain',
          fileVersion: 1,
        },
        kind: 'txt',
        chunks: extractedChunks,
      },
    });
    expect(Date.parse(preview.json().preview.expiresAt)).toBeGreaterThan(Date.now());
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM knowledge_chunks')).rows).toEqual([]);
    expect(
      (await pool.query('SELECT destination_scope_kind FROM knowledge_promotion_intents')).rows,
    ).toEqual([{ destination_scope_kind: 'group' }]);
  });
});

describe('KNW-01 text-like promotion confirm', () => {
  it('persists chunks with file version and locators only after a bound preview is confirmed', async () => {
    const { app, pool, base, group, owner } = await fixture();
    const messageId = await uploadedMessage(app, base);
    const preview = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/preview`,
      headers,
      payload: { scope: { kind: 'group', id: group.id } },
    });
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/messages/${messageId}/knowledge/confirmations`,
          headers,
          payload: {
            intentId: preview.json().preview.id,
            idempotencyKey: 'confirm-knowledge-1',
            acknowledged: false,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    const confirmed = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/confirmations`,
      headers,
      payload: {
        intentId: preview.json().preview.id,
        idempotencyKey: 'confirm-knowledge-1',
        acknowledged: true,
      },
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().document).toMatchObject({
      scope: { kind: 'group', id: group.id },
      source: {
        attachmentId: preview.json().preview.source.attachmentId,
        messageId,
        filename: 'notes.txt',
        mediaType: 'text/plain',
        fileVersion: 1,
      },
      kind: 'txt',
      extractorVersion: TEXT_KNOWLEDGE_EXTRACTOR_VERSION,
      approver: { id: owner.user.id },
      chunks: [
        { position: 1, ...extractedChunks[0] },
        { position: 2, ...extractedChunks[1] },
      ],
    });
    expect(Date.parse(String(confirmed.json().document.approvedAt))).toBeGreaterThan(0);
    expect(
      (
        await pool.query(
          'SELECT file_version,locator_kind,locator_start,locator_end,text FROM knowledge_chunks ORDER BY position',
        )
      ).rows,
    ).toEqual([
      {
        file_version: 1,
        locator_kind: 'line',
        locator_start: 1,
        locator_end: 1,
        text: 'Quarterly notes',
      },
      {
        file_version: 1,
        locator_kind: 'line',
        locator_start: 2,
        locator_end: 2,
        text: 'Keep the cobalt key',
      },
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/messages/${messageId}/knowledge/confirmations`,
          headers,
          payload: {
            intentId: preview.json().preview.id,
            idempotencyKey: 'confirm-knowledge-1',
            acknowledged: true,
          },
        })
      ).json().document.id,
    ).toBe(confirmed.json().document.id);
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toHaveLength(1);
    expect(
      JSON.stringify(
        (
          await pool.query(
            "SELECT metadata FROM audit_events WHERE event_type='knowledge.promoted'",
          )
        ).rows,
      ),
    ).not.toContain('cobalt');
  });

  it('denies confirm without a valid preview, for the wrong actor, or after expiry', async () => {
    const {
      app,
      pool,
      base,
      group,
      groups,
      addUser,
      owner,
      knowledgePool,
      attachments,
      conversation,
    } = await fixture();
    const messageId = await uploadedMessage(app, base);
    const member = await addUser();
    await groups.addMember(owner.user.id, owner.workspace.id, group.id, {
      userId: member.id,
      role: 'member',
    });
    const stranger = await addUser();
    const preview = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/preview`,
      headers,
      payload: { scope: { kind: 'group', id: group.id } },
    });
    expect(preview.statusCode).toBe(200);
    const missing = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/confirmations`,
      headers,
      payload: {
        intentId: randomUUID(),
        idempotencyKey: 'missing-intent',
        acknowledged: true,
      },
    });
    expect(missing.statusCode).toBe(403);
    const wrongActor = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/confirmations`,
      headers: member.headers,
      payload: {
        intentId: preview.json().preview.id,
        idempotencyKey: 'wrong-actor',
        acknowledged: true,
      },
    });
    expect(wrongActor.statusCode).toBe(403);
    const outsider = await app.inject({
      method: 'POST',
      url: `${base}/messages/${messageId}/knowledge/confirmations`,
      headers: stranger.headers,
      payload: {
        intentId: preview.json().preview.id,
        idempotencyKey: 'outsider',
        acknowledged: true,
      },
    });
    expect(outsider.statusCode).toBe(403);
    const stale = new KnowledgeService(
      knowledgePool,
      attachments,
      () => new Date(Date.now() + 6 * 60 * 1000),
    );
    await expect(
      stale.confirm(
        {
          actorUserId: owner.user.id,
          workspaceId: owner.workspace.id,
          conversationId: conversation.id,
        },
        messageId,
        {
          intentId: preview.json().preview.id,
          idempotencyKey: 'expired-intent',
          acknowledged: true,
        },
      ),
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
    expect((await pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM knowledge_chunks')).rows).toEqual([]);
  });
});

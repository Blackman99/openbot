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

async function fixture() {
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
  const knowledge = new KnowledgeService(attachments);
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
  return { app, pool, base };
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
});

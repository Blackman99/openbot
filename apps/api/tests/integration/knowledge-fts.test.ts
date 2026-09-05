import type { ObjectStore } from '../../src/objects/store.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { selectRunKnowledgeContribution } from '../../src/knowledge/run-context.js';
import {
  KNOWLEDGE_SEARCH,
  knowledgeAttachmentHref,
  knowledgeMatchTerms,
  knowledgeTsQuery,
} from '../../src/knowledge/citation.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { buildApp } from '../../src/app.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { TaskService } from '../../src/tasks/service.js';
import type { SqlConnection } from '../../src/auth/postgres-auth-repository.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function envelope(command: unknown, content: Buffer) {
  const json = Buffer.from(JSON.stringify(command));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, content]);
}

async function fixture(body: string) {
  const f = await botAclFixture(cleanup);
  const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
  const conversation = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
    subject: { kind: 'direct-bot', id: f.bot.id },
  });
  const root = await mkdtemp(join(tmpdir(), 'openbot-knowledge-fts-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store: ObjectStore = new LocalObjectStore(root, { maxObjectBytes: 10 * 1024 * 1024 });
  const attachments = new AttachmentService(f.pool, store);
  const knowledge = new KnowledgeService(f.pool, attachments);
  const app = buildApp({
    auth: f.auth,
    conversations,
    attachments,
    knowledge,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  const bytes = Buffer.from(body);
  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}/attachments`,
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload: envelope(
      {
        idempotencyKey: 'attach-fts',
        body: 'Read these notes',
        filename: 'notes.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      bytes,
    ),
  });
  expect(uploaded.statusCode).toBe(200);
  const messageId = uploaded.json().receipt.messageId as string;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}/messages/${messageId}/knowledge/preview`,
        headers: f.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  const promoted = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}/messages/${messageId}/knowledge/promotions`,
    headers: f.headers,
    payload: {
      destination: { kind: 'bot', id: f.bot.id },
      idempotencyKey: 'promote-fts',
      acknowledged: true,
    },
  });
  expect(promoted.statusCode).toBe(201);
  return {
    ...f,
    conversation,
    messageId,
    document: promoted.json().document as { id: string },
  };
}

describe('KNW-01 PostgreSQL full-text search without embeddings', () => {
  it('matches whole tokens after authorized isolation and does not use ILIKE substrings', async () => {
    expect(KNOWLEDGE_SEARCH).toBe('postgresql-fts-simple');
    expect(knowledgeTsQuery(knowledgeMatchTerms('What happened?'))).toBe('what | happened');
    const substring = await fixture('somewhat later\n');
    const exact = await fixture('Keep the cobalt key\n');
    const unmatched = await new TaskService(substring.pool).submit(
      substring.owner.user.id,
      substring.owner.workspace.id,
      substring.conversation.id,
      { idempotencyKey: 'fts-somewhat', body: 'What happened?' },
    );
    const matched = await new TaskService(exact.pool).submit(
      exact.owner.user.id,
      exact.owner.workspace.id,
      exact.conversation.id,
      { idempotencyKey: 'fts-cobalt', body: 'What is the cobalt key?' },
    );
    const captured: string[] = [];
    const raw = await substring.pool.connect();
    const probe: SqlConnection = {
      query: (statement, parameters) => {
        captured.push(statement);
        return raw.query(statement, parameters);
      },
      release: () => raw.release(),
    };
    try {
      await probe.query('BEGIN');
      expect(await selectRunKnowledgeContribution(probe, unmatched.runs[0]!.id)).toMatchObject({
        messages: [],
        references: [],
        itemCount: 0,
      });
      await probe.query('ROLLBACK');
    } finally {
      probe.release();
    }
    const retrieval = captured.find((statement) => statement.includes('knowledge_fts_match'));
    expect(retrieval).toBeDefined();
    expect(retrieval).toMatch(/WITH authorized AS/i);
    expect(retrieval!.indexOf('WITH authorized AS')).toBeLessThan(
      retrieval!.indexOf('knowledge_fts_match'),
    );
    expect(retrieval).not.toContain('ILIKE');
    const cited = await exact.pool.connect();
    try {
      await cited.query('BEGIN');
      const contribution = await selectRunKnowledgeContribution(cited, matched.runs[0]!.id);
      expect(contribution.itemCount).toBe(1);
      expect(JSON.parse(contribution.messages[0]!.content)).toMatchObject({
        kind: 'scoped_knowledge',
        untrusted: true,
        chunks: [
          {
            text: 'Keep the cobalt key',
            source: {
              messageId: exact.messageId,
              href: knowledgeAttachmentHref({
                workspaceId: exact.owner.workspace.id,
                conversationId: exact.conversation.id,
                messageId: exact.messageId,
              }),
            },
          },
        ],
      });
      await cited.query('ROLLBACK');
    } finally {
      cited.release();
    }
  });
});

import type { ObjectStore } from '../../src/objects/store.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import {
  persistRunKnowledgeReferences,
  selectRunKnowledgeContribution,
} from '../../src/knowledge/run-context.js';
import {
  knowledgeAttachmentContentHref,
  knowledgeAttachmentHref,
  UNTRUSTED_KNOWLEDGE_WARNING,
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
import { TaskQueue } from '../../src/tasks/queue.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import type { ModelInput } from '../../src/providers/model-events.js';

const bytes = Buffer.from('Quarterly notes\nKeep the cobalt key\n');
const metadata = {
  idempotencyKey: 'attach-knowledge-run-1',
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

function envelope(command: unknown, content: Buffer) {
  const json = Buffer.from(JSON.stringify(command));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, content]);
}

async function fixture() {
  const f = await botAclFixture(cleanup);
  const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
  const conversation = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
    subject: { kind: 'direct-bot', id: f.bot.id },
  });
  const root = await mkdtemp(join(tmpdir(), 'openbot-knowledge-run-'));
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
  const base = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}`;
  const uploaded = await app.inject({
    method: 'POST',
    url: `${base}/attachments`,
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload: envelope(metadata, bytes),
  });
  expect(uploaded.statusCode).toBe(200);
  const messageId = uploaded.json().receipt.messageId as string;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/messages/${messageId}/knowledge/preview`,
        headers: f.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  const promoted = await app.inject({
    method: 'POST',
    url: `${base}/messages/${messageId}/knowledge/promotions`,
    headers: f.headers,
    payload: {
      destination: { kind: 'bot', id: f.bot.id },
      idempotencyKey: 'promote-bot-notes',
      acknowledged: true,
    },
  });
  expect(promoted.statusCode).toBe(201);
  const document = promoted.json().document as {
    id: string;
    source: { attachmentId: string; messageId: string; filename: string; fileVersion: number };
  };
  const tasks = new TaskService(f.pool);
  const task = await tasks.submit(f.owner.user.id, f.owner.workspace.id, conversation.id, {
    idempotencyKey: 'cite-cobalt',
    body: 'What is the cobalt key?',
  });
  return {
    ...f,
    app,
    conversations,
    conversation,
    base,
    messageId,
    document,
    tasks,
    task,
    runId: task.runs[0]!.id,
  };
}

describe('KNW-01 authorized run retrieval and citation', () => {
  it('retrieves a matching scoped chunk with an ATT-01 source reference that opens the file', async () => {
    const f = await fixture();
    const connection = await f.pool.connect();
    let contribution;
    try {
      await connection.query('BEGIN');
      contribution = await selectRunKnowledgeContribution(connection, f.runId);
      expect(contribution.itemCount).toBe(1);
      expect(contribution.references).toEqual([
        { chunkId: expect.any(String), documentId: f.document.id },
      ]);
      expect(JSON.parse(contribution.messages[0]!.content)).toEqual({
        kind: 'scoped_knowledge',
        untrusted: true,
        warning: UNTRUSTED_KNOWLEDGE_WARNING,
        chunks: [
          {
            id: contribution.references[0]!.chunkId,
            documentId: f.document.id,
            text: 'Keep the cobalt key',
            fileVersion: 1,
            mediaType: 'text/plain',
            locator: { kind: 'line', start: 2, end: 2 },
            source: {
              attachmentId: f.document.source.attachmentId,
              messageId: f.messageId,
              conversationId: f.conversation.id,
              workspaceId: f.owner.workspace.id,
              filename: 'notes.txt',
              fileVersion: 1,
              locator: { kind: 'line', start: 2, end: 2 },
              href: knowledgeAttachmentHref({
                workspaceId: f.owner.workspace.id,
                conversationId: f.conversation.id,
                messageId: f.messageId,
              }),
              contentHref: knowledgeAttachmentContentHref({
                workspaceId: f.owner.workspace.id,
                conversationId: f.conversation.id,
                messageId: f.messageId,
              }),
            },
          },
        ],
      });
      await expect(persistRunKnowledgeReferences(connection, contribution)).rejects.toThrow();
      expect((await connection.query('SELECT run_id FROM run_knowledge_references')).rows).toEqual(
        [],
      );
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
    const href = knowledgeAttachmentHref({
      workspaceId: f.owner.workspace.id,
      conversationId: f.conversation.id,
      messageId: f.messageId,
    });
    const view = await f.app.inject({ url: href, headers: f.headers });
    expect(view.statusCode).toBe(200);
    expect(view.json().attachment).toMatchObject({
      id: f.document.source.attachmentId,
      filename: 'notes.txt',
      mediaType: 'text/plain',
    });
    const download = await f.app.inject({ url: `${href}/content`, headers: f.headers });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(bytes);
    expect(download.headers['content-disposition']).toContain('notes.txt');
  });

  it('sends the matching chunk to the provider and records locator-only run citations', async () => {
    const f = await fixture();
    let sent: ModelInput['messages'] = [];
    const worker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          sent = input.messages;
          return {
            events: [
              { type: 'text', text: 'The cobalt key is in the notes.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    const contribution = sent.find((message) =>
      message.content.startsWith('{"kind":"scoped_knowledge"'),
    );
    expect(contribution).toBeDefined();
    expect(JSON.parse(contribution!.content)).toMatchObject({
      kind: 'scoped_knowledge',
      untrusted: true,
      warning: UNTRUSTED_KNOWLEDGE_WARNING,
      chunks: [
        {
          text: 'Keep the cobalt key',
          locator: { kind: 'line', start: 2, end: 2 },
          source: {
            messageId: f.messageId,
            filename: 'notes.txt',
            href: knowledgeAttachmentHref({
              workspaceId: f.owner.workspace.id,
              conversationId: f.conversation.id,
              messageId: f.messageId,
            }),
          },
        },
      ],
    });
    const rows = (
      await f.pool.query(
        'SELECT run_id,chunk_id,document_id FROM run_knowledge_references WHERE run_id=$1',
        [f.runId],
      )
    ).rows;
    expect(rows).toEqual([
      {
        run_id: f.runId,
        chunk_id: expect.any(String),
        document_id: f.document.id,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('cobalt');
    expect(
      (await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id))
        .status,
    ).toBe('completed');
    expect((await new TaskQueue(f.pool).claimNext()).handled).toBe(false);
  });

  it('does not retrieve unmatched chunks for an authorized run', async () => {
    const f = await fixture();
    const later = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'unrelated-run',
      body: 'Summarize yesterday weather.',
    });
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      expect(await selectRunKnowledgeContribution(connection, later.runs[0]!.id)).toMatchObject({
        messages: [],
        references: [],
        itemCount: 0,
        bytes: 0,
      });
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
  });
});

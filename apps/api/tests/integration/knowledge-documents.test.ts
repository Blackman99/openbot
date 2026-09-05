import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentService } from '../../src/attachments/service.js';
import { buildApp } from '../../src/app.js';
import { knowledgeAttachmentHref } from '../../src/knowledge/citation.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import {
  attachmentMeta,
  knowledgeDocx,
  knowledgeXlsx,
  textPdf,
  zipFiles,
} from '../helpers/document-bytes.js';
import type { ModelInput } from '../../src/providers/model-events.js';

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
  const root = await mkdtemp(join(tmpdir(), 'openbot-doc-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const attachments = new AttachmentService(
    f.pool,
    new LocalObjectStore(root, { maxObjectBytes: 10 * 1024 * 1024 }),
  );
  const knowledge = new KnowledgeService(f.pool, attachments);
  const app = buildApp({
    auth: f.auth,
    conversations,
    attachments,
    knowledge,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  return {
    ...f,
    app,
    conversation,
    base: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}`,
  };
}

async function uploadAndPromote(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes: Buffer,
  filename: string,
  mediaType: string,
  key: string,
) {
  const uploaded = await f.app.inject({
    method: 'POST',
    url: `${f.base}/attachments`,
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload: envelope(attachmentMeta(bytes, filename, mediaType, key), bytes),
  });
  expect(uploaded.statusCode).toBe(200);
  const messageId = uploaded.json().receipt.messageId as string;
  const preview = await f.app.inject({
    method: 'POST',
    url: `${f.base}/messages/${messageId}/knowledge/preview`,
    headers: f.headers,
    payload: {},
  });
  expect(preview.statusCode).toBe(200);
  const promoted = await f.app.inject({
    method: 'POST',
    url: `${f.base}/messages/${messageId}/knowledge/promotions`,
    headers: f.headers,
    payload: {
      destination: { kind: 'bot', id: f.bot.id },
      idempotencyKey: `promote-${key}`,
      acknowledged: true,
    },
  });
  expect(promoted.statusCode).toBe(201);
  return {
    messageId,
    preview: preview.json().preview,
    document: promoted.json().document as { id: string; source: { fileVersion: number } },
  };
}

describe('DOC-01 rich document knowledge locators', () => {
  it('promotes a text PDF with searchable page locators that open the source file', async () => {
    const f = await fixture();
    const bytes = textPdf(['Quarterly notes', 'Keep the cobalt key']);
    const promoted = await uploadAndPromote(f, bytes, 'notes.pdf', 'application/pdf', 'pdf-notes');
    expect(promoted.preview.chunks).toEqual([
      { text: 'Quarterly notes', fileVersion: 1, locator: { kind: 'page', start: 1, end: 1 } },
      { text: 'Keep the cobalt key', fileVersion: 1, locator: { kind: 'page', start: 2, end: 2 } },
    ]);
    const href = knowledgeAttachmentHref({
      workspaceId: f.owner.workspace.id,
      conversationId: f.conversation.id,
      messageId: promoted.messageId,
    });
    const view = await f.app.inject({ url: href, headers: f.headers });
    expect(view.statusCode).toBe(200);
    expect(view.json().attachment).toMatchObject({ filename: 'notes.pdf' });
    const download = await f.app.inject({ url: `${href}/content`, headers: f.headers });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(bytes);
  });

  it('promotes DOCX and XLSX locators that resolve through the attachment viewer', async () => {
    const f = await fixture();
    const docx = await uploadAndPromote(
      f,
      knowledgeDocx('Quarterly notes', 'Keep the cobalt key'),
      'notes.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx-notes',
    );
    expect(docx.preview.chunks).toEqual([
      {
        text: 'Quarterly notes',
        fileVersion: 1,
        locator: { kind: 'paragraph', start: 1, end: 1, ref: 'Quarterly notes' },
      },
      {
        text: 'Keep the cobalt key',
        fileVersion: 1,
        locator: { kind: 'paragraph', start: 2, end: 2, ref: 'Quarterly notes' },
      },
    ]);
    expect(
      (
        await f.app.inject({
          url: knowledgeAttachmentHref({
            workspaceId: f.owner.workspace.id,
            conversationId: f.conversation.id,
            messageId: docx.messageId,
          }),
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(200);
    const xlsx = await uploadAndPromote(
      f,
      knowledgeXlsx('Keys', 'B2', 'Keep the cobalt key'),
      'keys.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx-keys',
    );
    expect(xlsx.preview.chunks).toEqual([
      {
        text: 'Keep the cobalt key',
        fileVersion: 1,
        locator: { kind: 'cells', start: 2, end: 2, ref: 'Keys!B2:B2' },
      },
    ]);
    expect(
      (
        await f.app.inject({
          url: knowledgeAttachmentHref({
            workspaceId: f.owner.workspace.id,
            conversationId: f.conversation.id,
            messageId: xlsx.messageId,
          }),
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('enters an explicit failed state for encrypted, corrupt, unsupported, and over-limit documents without writing chunks', async () => {
    const f = await fixture();
    const oversized = zipFiles(
      Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`part-${index}.xml`, 'x'])),
    );
    for (const [bytes, filename, mediaType, key, code] of [
      [
        textPdf(['hidden'], { encrypt: true }),
        'secret.pdf',
        'application/pdf',
        'encrypted',
        'encrypted_file',
      ],
      [Buffer.from('%PDF-1.4\nbad'), 'broken.pdf', 'application/pdf', 'corrupt', 'corrupt_file'],
      [textPdf(['']), 'empty.pdf', 'application/pdf', 'empty', 'unsupported_file'],
      [
        oversized,
        'huge.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'overlimit',
        'invalid_attachment',
      ],
    ] as const) {
      const uploaded = await f.app.inject({
        method: 'POST',
        url: `${f.base}/attachments`,
        headers: { ...f.headers, 'content-type': 'application/octet-stream' },
        payload: envelope(attachmentMeta(bytes, filename, mediaType, key), bytes),
      });
      if (key === 'corrupt' || key === 'overlimit') {
        expect(uploaded.statusCode).toBe(400);
        expect((await f.pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
        continue;
      }
      expect(uploaded.statusCode).toBe(200);
      const messageId = uploaded.json().receipt.messageId as string;
      const preview = await f.app.inject({
        method: 'POST',
        url: `${f.base}/messages/${messageId}/knowledge/preview`,
        headers: f.headers,
        payload: {},
      });
      expect(preview.statusCode).toBe(400);
      expect(preview.json()).toEqual({ error: { code } });
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${f.base}/messages/${messageId}/knowledge/promotions`,
            headers: f.headers,
            payload: {
              destination: { kind: 'bot', id: f.bot.id },
              idempotencyKey: `fail-${key}`,
              acknowledged: true,
            },
          })
        ).json(),
      ).toEqual({ error: { code } });
    }
    expect((await f.pool.query('SELECT id FROM knowledge_documents')).rows).toEqual([]);
    expect((await f.pool.query('SELECT id FROM knowledge_chunks')).rows).toEqual([]);
  });

  it('stores a replacement as a new immutable version and keeps historical citations resolvable', async () => {
    const f = await fixture();
    const first = await uploadAndPromote(
      f,
      textPdf(['Keep the cobalt key']),
      'notes.pdf',
      'application/pdf',
      'pdf-v1',
    );
    expect(first.document.source.fileVersion).toBe(1);
    const tasks = new TaskService(f.pool);
    await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'cite-v1',
      body: 'What is the cobalt key?',
    });
    const firstSent: ModelInput['messages'] = [];
    const firstWorker = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          firstSent.push(...input.messages);
          return {
            events: [
              { type: 'text', text: 'Cited the current notes.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await firstWorker.runOnce()).toBe(true);
    expect(
      JSON.parse(
        firstSent.find((message) => message.content.includes('"kind":"scoped_knowledge"'))!.content,
      ).chunks.map((chunk: { text: string }) => chunk.text),
    ).toEqual(['Keep the cobalt key']);
    const firstRefs = (
      await f.pool.query('SELECT chunk_id,document_id FROM run_knowledge_references')
    ).rows;
    expect(firstRefs).toEqual([{ chunk_id: expect.any(String), document_id: first.document.id }]);
    const second = await uploadAndPromote(
      f,
      textPdf(['Keep the indigo key']),
      'notes.pdf',
      'application/pdf',
      'pdf-v2',
    );
    expect(second.document.source.fileVersion).toBe(2);
    expect(second.document.id).not.toBe(first.document.id);
    expect(
      (
        await f.pool.query(
          'SELECT file_version FROM knowledge_documents WHERE filename=$1 ORDER BY file_version',
          ['notes.pdf'],
        )
      ).rows,
    ).toEqual([{ file_version: 1 }, { file_version: 2 }]);
    await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'cite-v2',
      body: 'What is the indigo key?',
    });
    const laterSent: ModelInput['messages'] = [];
    const later = new TaskWorker(f.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          laterSent.push(...input.messages);
          return {
            events: [
              { type: 'text', text: 'The indigo key is current.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await later.runOnce()).toBe(true);
    const payload = JSON.parse(
      laterSent.find((message) => message.content.includes('"kind":"scoped_knowledge"'))!.content,
    );
    expect(payload.chunks.map((chunk: { text: string }) => chunk.text)).toEqual([
      'Keep the indigo key',
    ]);
    expect(JSON.stringify(payload)).not.toContain('cobalt');
    expect(
      (
        await f.pool.query(
          'SELECT chunk_id,document_id FROM run_knowledge_references WHERE document_id=$1',
          [first.document.id],
        )
      ).rows,
    ).toEqual(firstRefs);
    const historical = (
      await f.pool.query<{ text: string; file_version: string | number }>(
        `SELECT c.text, c.file_version FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id=c.document_id
         WHERE d.id=$1`,
        [first.document.id],
      )
    ).rows;
    expect(historical).toEqual([{ text: 'Keep the cobalt key', file_version: 1 }]);
    const href = knowledgeAttachmentHref({
      workspaceId: f.owner.workspace.id,
      conversationId: f.conversation.id,
      messageId: first.messageId,
    });
    expect((await f.app.inject({ url: href, headers: f.headers })).statusCode).toBe(200);
    expect((await f.app.inject({ url: `${href}/content`, headers: f.headers })).rawPayload).toEqual(
      textPdf(['Keep the cobalt key']),
    );
  });
});

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentService } from '../../src/attachments/service.js';
import { buildApp } from '../../src/app.js';
import { knowledgeAttachmentHref, knowledgeMatchTerms } from '../../src/knowledge/citation.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import {
  selectRunKnowledgeContribution,
  selectScopedKnowledgeChunks,
} from '../../src/knowledge/run-context.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import type { ModelInput } from '../../src/providers/model-events.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import {
  assembleRunContext,
  CONTEXT_PRIORITY,
  type ContextKind,
} from '../../src/retrieval/assemble.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { memoryFixture } from '../helpers/memory-fixture.js';

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

function classify(content: string, index: number): ContextKind {
  if (index === 0) return 'system';
  if (
    content.includes('"kind":"group_memories"') ||
    content.includes('"kind":"bot_private_memories"') ||
    content.includes('"kind":"approved_facts"')
  )
    return 'memory';
  if (content.includes('"kind":"scoped_knowledge"')) return 'knowledge';
  return 'ledger';
}

async function captureRun(
  pool: Awaited<ReturnType<typeof memoryFixture>>['pool'],
  reply = 'Cited the supplied context.',
) {
  let sent: ModelInput['messages'] = [];
  const worker = new TaskWorker(pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async (input) => {
        sent = input.messages;
        return {
          events: [
            { type: 'text', text: reply },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        };
      },
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  return sent;
}

async function knowledgeApp(f: Awaited<ReturnType<typeof memoryFixture>>) {
  const root = await mkdtemp(join(tmpdir(), 'openbot-retrieval-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const attachments = new AttachmentService(
    f.pool,
    new LocalObjectStore(root, { maxObjectBytes: 10 * 1024 * 1024 }),
  );
  const knowledge = new KnowledgeService(f.pool, attachments);
  const app = buildApp({
    auth: f.auth,
    conversations: f.conversations,
    attachments,
    knowledge,
    memories: f.memories,
    groups: f.groups,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  return { app, knowledge };
}

async function promote(
  f: Awaited<ReturnType<typeof memoryFixture>>,
  app: ReturnType<typeof buildApp>,
  conversationId: string,
  body: string,
  destination: { kind: 'bot' | 'group'; id: string },
  key: string,
) {
  const bytes = Buffer.from(body);
  const base = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversationId}`;
  const uploaded = await app.inject({
    method: 'POST',
    url: `${base}/attachments`,
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload: envelope(
      {
        idempotencyKey: key,
        body: 'Promote these notes',
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
    payload: { destination, idempotencyKey: key, acknowledged: true },
  });
  expect(promoted.statusCode).toBe(201);
  return {
    messageId,
    document: promoted.json().document as { id: string },
  };
}

describe('RET-01 permission-aware context assembly', () => {
  it('filters unauthorized sources before ranking, records resolvable provenance, and cites only supplied items', async () => {
    const f = await memoryFixture(cleanup);
    const saved = (
      await f.memories.create(
        { actorUserId: f.member.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
        f.command,
      )
    ).memory;
    const otherGroup = await f.groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Foreign retrieval group',
    });
    const otherConversation = await f.conversations.open(f.owner.user.id, f.owner.workspace.id, {
      subject: { kind: 'group', id: otherGroup.id },
    });
    const foreignSource = await f.conversations.append(
      f.owner.user.id,
      f.owner.workspace.id,
      otherConversation.id,
      { body: 'FOREIGN-MEMORY-MARKER', idempotencyKey: 'foreign-source' },
    );
    await f.memories.create(
      { actorUserId: f.owner.user.id, workspaceId: f.owner.workspace.id, groupId: otherGroup.id },
      {
        messageId: foreignSource.messageId,
        expectedSourceEventId: foreignSource.eventId,
        confidence: 0.5,
        idempotencyKey: 'foreign-memory',
      },
    );
    const { app } = await knowledgeApp(f);
    const cited = await promote(
      f,
      app,
      f.conversation.id,
      'Quarterly notes\nKeep the cobalt key\n',
      { kind: 'bot', id: f.bot.id },
      'promote-cited',
    );
    await promote(
      f,
      app,
      otherConversation.id,
      'FOREIGN-KNOWLEDGE-MARKER cobalt key policy matching query exactly\n',
      { kind: 'group', id: otherGroup.id },
      'promote-foreign',
    );
    const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      botId: f.bot.id,
      idempotencyKey: 'retrieve',
      history: { mode: 'all' },
    });
    const tasks = new TaskService(f.pool);
    const task = await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      body: 'What is the cobalt key?',
      groupGrantId: grant.id,
      idempotencyKey: 'retrieve-run',
    });
    const sent = await captureRun(f.pool);
    const kinds = sent.map((message, index) => classify(message.content, index));
    expect(CONTEXT_PRIORITY).toEqual(['system', 'memory', 'knowledge', 'ledger']);
    expect(kinds[0]).toBe('system');
    expect(kinds.filter((kind) => kind === 'memory').length).toBeGreaterThan(0);
    expect(kinds.filter((kind) => kind === 'knowledge')).toEqual(['knowledge']);
    expect(kinds.indexOf('memory')).toBeLessThan(kinds.indexOf('knowledge'));
    expect(kinds.indexOf('knowledge')).toBeLessThan(kinds.indexOf('ledger'));
    expect(sent.some((message) => message.content.includes(saved.text))).toBe(true);
    expect(sent.some((message) => message.content.includes('FOREIGN-MEMORY-MARKER'))).toBe(false);
    expect(sent.some((message) => message.content.includes('FOREIGN-KNOWLEDGE-MARKER'))).toBe(
      false,
    );
    const knowledgeMessage = sent.find((message) =>
      message.content.includes('"kind":"scoped_knowledge"'),
    );
    expect(knowledgeMessage).toBeDefined();
    const citation = (
      JSON.parse(knowledgeMessage!.content) as {
        chunks: Array<{
          id: string;
          documentId: string;
          text: string;
          fileVersion: number;
          locator: { kind: string; start: number; end: number };
          source: { href: string };
        }>;
      }
    ).chunks[0]!;
    expect(citation.text).toBe('Keep the cobalt key');
    expect(citation.source.href).toBe(
      knowledgeAttachmentHref({
        workspaceId: f.owner.workspace.id,
        conversationId: f.conversation.id,
        messageId: cited.messageId,
      }),
    );
    expect(sent.some((message) => message.content.includes(citation.text))).toBe(true);
    expect(sent.some((message) => message.content.includes(citation.source.href))).toBe(true);
    const memoryRows = (
      await f.pool.query<{
        source_id: string;
        group_id: string;
        version_id: string;
        memory_version_id: string;
      }>(
        `SELECT r.source_event_id AS source_id, m.group_id, v.id AS version_id, r.memory_version_id
         FROM run_memory_references r
         JOIN memory_versions v ON v.id=r.memory_version_id AND v.source_event_id=r.source_event_id
         JOIN group_memories m ON m.id=v.memory_id
         WHERE r.run_id=$1`,
        [task.runs[0]!.id],
      )
    ).rows;
    expect(memoryRows).toEqual([
      {
        source_id: f.source.eventId,
        group_id: f.group.id,
        version_id: saved.versionId,
        memory_version_id: saved.versionId,
      },
    ]);
    const knowledgeRows = (
      await f.pool.query<{
        document_id: string;
        chunk_id: string;
        file_version: string | number;
        locator_kind: string;
        locator_start: string | number;
        locator_end: string | number;
        scope_kind: string;
        scope_id: string;
      }>(
        `SELECT r.document_id, r.chunk_id, c.file_version, c.locator_kind, c.locator_start, c.locator_end, d.scope_kind, d.scope_id
         FROM run_knowledge_references r
         JOIN knowledge_chunks c ON c.id=r.chunk_id AND c.document_id=r.document_id
         JOIN knowledge_documents d ON d.id=r.document_id
         WHERE r.run_id=$1`,
        [task.runs[0]!.id],
      )
    ).rows;
    expect(knowledgeRows).toHaveLength(1);
    expect(knowledgeRows[0]).toMatchObject({
      document_id: cited.document.id,
      chunk_id: citation.id,
      locator_kind: citation.locator.kind,
      scope_kind: 'bot',
      scope_id: f.bot.id,
    });
    expect(Number(knowledgeRows[0]!.file_version)).toBe(citation.fileVersion);
    expect(Number(knowledgeRows[0]!.locator_start)).toBe(citation.locator.start);
    expect(Number(knowledgeRows[0]!.locator_end)).toBe(citation.locator.end);
    const reconstructed = sent.map((message, index) => ({
      kind: classify(message.content, index),
      id: `${classify(message.content, index)}-${index}`,
      role: message.role,
      content: message.content,
    }));
    const first = assembleRunContext(reconstructed);
    const second = assembleRunContext(reconstructed);
    expect(first.messages).toEqual(sent);
    expect(second.messages).toEqual(first.messages);
    expect(
      await tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id),
    ).toMatchObject({ status: 'completed' });
  }, 20000);

  it('omits tombstones, superseded versions, and history-bound memories from a newly assembled claim', async () => {
    const f = await memoryFixture(cleanup);
    const kept = (
      await f.memories.create(
        { actorUserId: f.member.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
        f.command,
      )
    ).memory;
    const edited = await f.memories.edit(
      { actorUserId: f.member.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
      kept.id,
      { expectedVersionId: kept.versionId, body: 'The launch code is indigo.' },
    );
    const forgottenSource = await f.conversations.append(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      { body: 'FORGOTTEN-MEMORY-MARKER', idempotencyKey: 'forget-source' },
    );
    const forgotten = (
      await f.memories.create(
        { actorUserId: f.member.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
        {
          messageId: forgottenSource.messageId,
          expectedSourceEventId: forgottenSource.eventId,
          confidence: 0.5,
          idempotencyKey: 'forget-memory',
        },
      )
    ).memory;
    await f.memories.forget(
      { actorUserId: f.member.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
      forgotten.id,
      { expectedVersionId: forgotten.versionId },
    );
    const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      botId: f.bot.id,
      idempotencyKey: 'current',
      history: { mode: 'all' },
    });
    const tasks = new TaskService(f.pool);
    await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      body: 'Use only current authorized memories.',
      groupGrantId: grant.id,
      idempotencyKey: 'current-run',
    });
    const sent = await captureRun(f.pool);
    const payload = sent.map((message) => message.content).join('\n');
    expect(payload).toContain('The launch code is indigo.');
    expect(payload).not.toContain('The launch code is cobalt.');
    expect(payload).not.toContain('FORGOTTEN-MEMORY-MARKER');
    expect(edited.text).toBe('The launch code is indigo.');
    await f.grants.remove(f.owner.user.id, f.owner.workspace.id, f.group.id, grant.id, {
      idempotencyKey: 'remove-current',
    });
    const bounded = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      botId: f.bot.id,
      idempotencyKey: 'future-only',
      history: { mode: 'future-only' },
    });
    await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      body: 'Ignore earlier group history.',
      groupGrantId: bounded.id,
      idempotencyKey: 'bounded-run',
    });
    const boundedSent = (await captureRun(f.pool)).map((message) => message.content).join('\n');
    expect(boundedSent).not.toContain('The launch code is indigo.');
    expect(boundedSent).not.toContain('The launch code is cobalt.');
    expect(boundedSent).not.toContain('FORGOTTEN-MEMORY-MARKER');
  }, 20000);

  it('rebuilds derived search data from authoritative chunks with an equivalent authorized set', async () => {
    const f = await memoryFixture(cleanup);
    const { app } = await knowledgeApp(f);
    await promote(
      f,
      app,
      f.conversation.id,
      'Quarterly notes\nKeep the cobalt key\n',
      { kind: 'bot', id: f.bot.id },
      'promote-rebuild',
    );
    const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      botId: f.bot.id,
      idempotencyKey: 'rebuild',
      history: { mode: 'all' },
    });
    const task = await new TaskService(f.pool).submit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      {
        body: 'What is the cobalt key?',
        groupGrantId: grant.id,
        idempotencyKey: 'rebuild-run',
      },
    );
    const terms = knowledgeMatchTerms('What is the cobalt key?');
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      const before = await selectScopedKnowledgeChunks(connection, {
        workspaceId: f.owner.workspace.id,
        scopes: [
          { kind: 'bot', id: f.bot.id },
          { kind: 'workspace', id: f.owner.workspace.id },
          { kind: 'group', id: f.group.id },
        ],
        terms,
        limit: 16,
      });
      expect(before.map((row) => row.text)).toEqual(['Keep the cobalt key']);
      expect(await selectRunKnowledgeContribution(connection, task.runs[0]!.id)).toMatchObject({
        itemCount: 1,
      });
      try {
        await connection.query('DROP INDEX IF EXISTS knowledge_chunk_fts_idx');
      } catch {
        // pg-mem may not materialize the GIN index created on PostgreSQL.
      }
      try {
        await connection.query(
          `CREATE INDEX knowledge_chunk_fts_idx ON knowledge_chunks USING GIN (to_tsvector('simple', text))`,
        );
      } catch {
        // Authoritative rows remain knowledge_chunks / knowledge_documents.
      }
      const after = await selectScopedKnowledgeChunks(connection, {
        workspaceId: f.owner.workspace.id,
        scopes: [
          { kind: 'bot', id: f.bot.id },
          { kind: 'workspace', id: f.owner.workspace.id },
          { kind: 'group', id: f.group.id },
        ],
        terms,
        limit: 16,
      });
      expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
      expect(after.map((row) => row.document_id)).toEqual(before.map((row) => row.document_id));
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
  }, 20000);
});

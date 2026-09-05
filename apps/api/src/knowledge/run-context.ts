import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { ConversationAccessError, conversationUuid } from '../conversations/service.js';
import { admitTaskTarget } from '../tasks/admission.js';
import {
  escapeKnowledgeLike,
  knowledgeMatchTerms,
  knowledgeSourceReference,
  knowledgeTsQuery,
  UNTRUSTED_KNOWLEDGE_WARNING,
} from './citation.js';
import type { KnowledgeLocatorKind } from './text-extractor.js';

export class KnowledgeContextLimitError extends Error {}
export const MAX_RUN_KNOWLEDGE = 100;

interface KnowledgeReference {
  readonly chunkId: string;
  readonly documentId: string;
}

export interface RunKnowledgeContribution {
  readonly runId: string;
  readonly messages: ReadonlyArray<{ readonly role: 'user'; readonly content: string }>;
  readonly itemCount: number;
  readonly bytes: number;
  readonly references: ReadonlyArray<KnowledgeReference>;
}

type RunSource = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  group_id: string | null;
  execution_user_id: string;
  bot_id: string;
  bot_version_id: string;
  group_grant_id: string | null;
  trigger_sequence: string | number;
  trigger_body: string | null;
  status: string;
};

export type KnowledgeRow = {
  id: string;
  document_id: string;
  file_version: string | number;
  locator_kind: KnowledgeLocatorKind;
  locator_start: string | number;
  locator_end: string | number;
  locator_ref: string | null;
  text: string;
  source_attachment_id: string;
  source_conversation_id: string;
  source_message_id: string;
  filename: string;
  workspace_id: string;
};

async function runSource(connection: SqlConnection, runId: string, now: () => Date) {
  const task = (
    await connection.query<RunSource>(
      `SELECT r.id,r.status,t.workspace_id,t.conversation_id,t.execution_user_id,t.bot_id,t.bot_version_id,t.group_grant_id,c.group_id,e.sequence AS trigger_sequence,e.body AS trigger_body
      FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
      JOIN conversation_events e ON e.id=t.trigger_event_id WHERE r.id=$1`,
      [conversationUuid(runId)],
    )
  ).rows[0];
  if (!task) throw new ConversationAccessError();
  const target = await admitTaskTarget(
    connection,
    {
      actorUserId: task.execution_user_id,
      workspaceId: task.workspace_id,
      conversationId: task.conversation_id,
    },
    task.group_grant_id,
    now,
    task.bot_version_id,
  );
  if (target.botId !== task.bot_id || target.groupGrantId !== task.group_grant_id)
    throw new ConversationAccessError();
  return { task, target };
}

function emptyContribution(runId: string): RunKnowledgeContribution {
  return Object.freeze({
    runId,
    messages: Object.freeze([]),
    itemCount: 0,
    bytes: 0,
    references: Object.freeze([]),
  });
}

export type KnowledgeScope = { kind: 'bot' | 'group' | 'workspace'; id: string };

function taskScopes(task: RunSource): KnowledgeScope[] {
  const scopes: KnowledgeScope[] = [
    { kind: 'bot', id: task.bot_id },
    { kind: 'workspace', id: task.workspace_id },
  ];
  if (task.group_id) scopes.push({ kind: 'group', id: task.group_id });
  return scopes;
}

function scopeSql(scopes: readonly KnowledgeScope[], parameters: unknown[]): string {
  return scopes
    .map((scope) => {
      parameters.push(scope.kind, scope.id);
      return `(d.scope_kind=$${parameters.length - 1} AND d.scope_id=$${parameters.length})`;
    })
    .join(' OR ');
}

function missingFullTextSearch(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === '42883' ||
    /to_tsvector|to_tsquery|ts_rank|plainto_tsquery|knowledge_fts_match|knowledge_fts_rank|function.*does not exist|unknown function/iu.test(
      message,
    )
  );
}

const CHUNK_FROM = `knowledge_chunks c
      JOIN knowledge_documents d ON d.id=c.document_id
      JOIN attachment_objects o ON o.id=d.source_attachment_id AND o.original_id IS NULL AND o.state='live'
        AND o.workspace_id=d.workspace_id AND o.conversation_id=d.source_conversation_id AND o.message_id=d.source_message_id
      LEFT JOIN message_purges p ON p.workspace_id=d.workspace_id AND p.conversation_id=d.source_conversation_id AND p.message_id=d.source_message_id`;

const CHUNK_COLUMNS = `c.id,c.document_id,c.file_version,c.locator_kind,c.locator_start,c.locator_end,c.locator_ref,c.text,c.position,
       d.source_attachment_id,d.source_conversation_id,d.source_message_id,d.filename,d.workspace_id`;

const PROJECTED_COLUMNS = `id,document_id,file_version,locator_kind,locator_start,locator_end,locator_ref,text,
       source_attachment_id,source_conversation_id,source_message_id,filename,workspace_id`;

function authorizedCte(
  filter: {
    workspaceId: string;
    scopes: readonly KnowledgeScope[];
    chunkId?: string;
    documentId?: string;
  },
  parameters: unknown[],
): string {
  parameters.push(filter.workspaceId);
  const scopes = scopeSql(filter.scopes, parameters);
  const currentJoin =
    filter.chunkId && filter.documentId
      ? ''
      : ` JOIN (
      SELECT workspace_id, scope_kind, scope_id, filename, MAX(file_version) AS file_version
      FROM knowledge_documents
      GROUP BY workspace_id, scope_kind, scope_id, filename
    ) current_doc ON current_doc.workspace_id=d.workspace_id AND current_doc.scope_kind=d.scope_kind
      AND current_doc.scope_id=d.scope_id AND current_doc.filename=d.filename
      AND current_doc.file_version=d.file_version`;
  let sql = `SELECT ${CHUNK_COLUMNS} FROM ${CHUNK_FROM}${currentJoin}
      WHERE d.workspace_id=$1 AND p.message_id IS NULL AND (${scopes})`;
  if (filter.chunkId && filter.documentId) {
    parameters.push(filter.chunkId, filter.documentId);
    sql += ` AND c.id=$${parameters.length - 1} AND c.document_id=$${parameters.length}`;
  }
  return sql;
}

export async function selectScopedKnowledgeChunks(
  connection: SqlConnection,
  filter: {
    workspaceId: string;
    scopes: readonly KnowledgeScope[];
    terms: readonly string[];
    chunkId?: string;
    documentId?: string;
    limit: number;
  },
): Promise<KnowledgeRow[]> {
  if (!filter.scopes.length || !filter.terms.length || filter.limit < 1) return [];
  const ftsParameters: unknown[] = [];
  const authorized = authorizedCte(filter, ftsParameters);
  ftsParameters.push(knowledgeTsQuery(filter.terms));
  const queryIndex = ftsParameters.length;
  ftsParameters.push(filter.limit);
  const ftsSql = `WITH authorized AS (${authorized})
      SELECT ${PROJECTED_COLUMNS} FROM authorized
      WHERE knowledge_fts_match(authorized.text, $${queryIndex})
      ORDER BY knowledge_fts_rank(authorized.text, $${queryIndex}) DESC, document_id, position
      LIMIT $${ftsParameters.length}`;
  try {
    return (await connection.query<KnowledgeRow>(ftsSql, ftsParameters)).rows;
  } catch (error) {
    if (!missingFullTextSearch(error)) throw error;
  }
  const likeParameters: unknown[] = [];
  const likeAuthorized = authorizedCte(filter, likeParameters);
  const likes = filter.terms
    .map((term) => {
      likeParameters.push(`%${escapeKnowledgeLike(term)}%`);
      return `authorized.text ILIKE $${likeParameters.length}`;
    })
    .join(' OR ');
  likeParameters.push(filter.limit);
  const likeSql = `WITH authorized AS (${likeAuthorized})
      SELECT ${PROJECTED_COLUMNS} FROM authorized
      WHERE (${likes})
      ORDER BY document_id, position LIMIT $${likeParameters.length}`;
  return (await connection.query<KnowledgeRow>(likeSql, likeParameters)).rows;
}

async function selectAuthorizedChunks(
  connection: SqlConnection,
  task: RunSource,
  terms: string[],
  extra: { chunkId?: string; documentId?: string; limit: number },
): Promise<KnowledgeRow[]> {
  return selectScopedKnowledgeChunks(connection, {
    workspaceId: task.workspace_id,
    scopes: taskScopes(task),
    terms,
    limit: extra.limit,
    ...(extra.chunkId ? { chunkId: extra.chunkId } : {}),
    ...(extra.documentId ? { documentId: extra.documentId } : {}),
  });
}

export function projectKnowledgeChunk(row: KnowledgeRow) {
  const locator = {
    kind: row.locator_kind,
    start: Number(row.locator_start),
    end: Number(row.locator_end),
    ...(row.locator_ref ? { ref: row.locator_ref } : {}),
  };
  return {
    id: row.id,
    documentId: row.document_id,
    text: row.text,
    fileVersion: Number(row.file_version),
    locator,
    source: knowledgeSourceReference({
      workspaceId: row.workspace_id,
      conversationId: row.source_conversation_id,
      messageId: row.source_message_id,
      attachmentId: row.source_attachment_id,
      filename: row.filename,
      fileVersion: Number(row.file_version),
      locator,
    }),
  };
}

async function currentChunk(
  connection: SqlConnection,
  task: RunSource,
  reference: KnowledgeReference,
  terms: string[],
) {
  const row = (
    await selectAuthorizedChunks(connection, task, terms, {
      chunkId: reference.chunkId,
      documentId: reference.documentId,
      limit: 1,
    })
  )[0];
  if (!row) throw new ConversationAccessError();
  return row;
}

export async function selectRunKnowledgeContribution(
  connection: SqlConnection,
  runId: string,
  now: () => Date = () => new Date(),
): Promise<RunKnowledgeContribution> {
  const { task } = await runSource(connection, runId, now);
  if (task.status !== 'queued') throw new ConversationAccessError();
  const terms = knowledgeMatchTerms(task.trigger_body ?? '');
  if (!terms.length) return emptyContribution(task.id);
  const rows = await selectAuthorizedChunks(connection, task, terms, {
    limit: MAX_RUN_KNOWLEDGE + 1,
  });
  if (rows.length > MAX_RUN_KNOWLEDGE) throw new KnowledgeContextLimitError();
  if (!rows.length) return emptyContribution(task.id);
  const chunks = rows.map(projectKnowledgeChunk);
  const messages = Object.freeze([
    Object.freeze({
      role: 'user' as const,
      content: JSON.stringify({
        kind: 'scoped_knowledge',
        untrusted: true,
        warning: UNTRUSTED_KNOWLEDGE_WARNING,
        chunks,
      }),
    }),
  ]);
  const bytes = Buffer.byteLength(messages[0]!.content);
  if (bytes > 1048576) throw new KnowledgeContextLimitError();
  return Object.freeze({
    runId: task.id,
    messages,
    itemCount: chunks.length,
    bytes,
    references: Object.freeze(
      rows.map((row) => Object.freeze({ chunkId: row.id, documentId: row.document_id })),
    ),
  });
}

export async function persistRunKnowledgeReferences(
  connection: SqlConnection,
  contribution: RunKnowledgeContribution,
  now: () => Date = () => new Date(),
) {
  const { task } = await runSource(connection, contribution.runId, now);
  if (task.status !== 'running') throw new ConversationAccessError();
  const terms = knowledgeMatchTerms(task.trigger_body ?? '');
  for (const reference of contribution.references) {
    await currentChunk(connection, task, reference, terms);
    await connection.query(
      'INSERT INTO run_knowledge_references(run_id,chunk_id,document_id,selected_at) VALUES($1,$2,$3,$4)',
      [task.id, reference.chunkId, reference.documentId, now()],
    );
  }
}

export async function assertRunKnowledgeReferencesCurrent(
  connection: SqlConnection,
  runId: string,
  now: () => Date = () => new Date(),
) {
  const { task } = await runSource(connection, runId, now);
  if (task.status !== 'running') throw new ConversationAccessError();
  const references = (
    await connection.query<{ chunk_id: string; document_id: string }>(
      'SELECT chunk_id,document_id FROM run_knowledge_references WHERE run_id=$1 ORDER BY chunk_id LIMIT $2',
      [task.id, MAX_RUN_KNOWLEDGE + 1],
    )
  ).rows;
  if (references.length > MAX_RUN_KNOWLEDGE) throw new ConversationAccessError();
  if (!references.length) return;
  const terms = knowledgeMatchTerms(task.trigger_body ?? '');
  for (const reference of references) {
    const row = (
      await selectAuthorizedChunks(connection, task, terms, {
        chunkId: reference.chunk_id,
        documentId: reference.document_id,
        limit: 1,
      })
    )[0];
    if (!row) throw new ConversationAccessError();
  }
}

import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { ConversationAccessError, conversationUuid } from '../conversations/service.js';
import { admitTaskTarget } from '../tasks/admission.js';
import {
  memoryRowColumns,
  memoryRowTables,
  privateMemoryCurrentFrom,
  privateMemoryCurrentWhere,
  privateMemoryRowColumns,
  projectCurrentMemory,
  selectCurrentMemoryRows,
  selectCurrentPrivateMemoryRows,
  type PrivateMemoryRow,
} from './current.js';
import { MemoryAccessError, type MemoryRow } from './types.js';
import { projectApprovedFact, selectApprovedFactRows } from './review.js';

export class MemoryContextLimitError extends Error {}
export const MAX_RUN_MEMORIES = 100;
interface GroupMemoryReference {
  readonly kind: 'group';
  readonly memoryVersionId: string;
  readonly sourceEventId: string;
}
interface PrivateMemoryReference {
  readonly kind: 'bot-private';
  readonly privateMemoryId: string;
  readonly sourceEventId: string;
}
interface ApprovedFactReference {
  readonly kind: 'approved-fact';
  readonly factId: string;
  readonly versionId: string;
}
type MemoryReference = GroupMemoryReference | PrivateMemoryReference | ApprovedFactReference;
export interface RunMemoryContribution {
  readonly runId: string;
  readonly messages: ReadonlyArray<{ readonly role: 'user'; readonly content: string }>;
  readonly itemCount: number;
  readonly bytes: number;
  readonly references: ReadonlyArray<MemoryReference>;
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
  status: string;
};
// All methods borrow the queue's SQL transaction. The queue retains its shared
// scope locks, claim fence and provider admission through these calls.
async function runSource(connection: SqlConnection, runId: string, now: () => Date) {
  const task = (
    await connection.query<RunSource>(
      `SELECT r.id,r.status,t.workspace_id,t.conversation_id,t.execution_user_id,t.bot_id,t.bot_version_id,t.group_grant_id,c.group_id,e.sequence AS trigger_sequence
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
type AdmittedRun = Awaited<ReturnType<typeof runSource>>;
async function currentPrivateReference(
  connection: SqlConnection,
  run: AdmittedRun,
  reference: PrivateMemoryReference,
) {
  const row = (
    await connection.query<PrivateMemoryRow>(
      `SELECT ${privateMemoryRowColumns} FROM ${privateMemoryCurrentFrom}
      WHERE ${privateMemoryCurrentWhere} AND p.workspace_id=$1 AND p.bot_id=$2 AND p.id=$3 AND p.source_event_id=$4`,
      [run.task.workspace_id, run.task.bot_id, reference.privateMemoryId, reference.sourceEventId],
    )
  ).rows[0];
  if (!row) throw new ConversationAccessError();
  return row;
}
async function currentApprovedFact(
  connection: SqlConnection,
  run: AdmittedRun,
  reference: ApprovedFactReference,
) {
  const rows = await selectApprovedFactRows(connection, {
    workspaceId: run.task.workspace_id,
    ...(run.task.group_id ? { groupId: run.task.group_id } : {}),
    botId: run.task.bot_id,
    includeWorkspace: true,
    limit: MAX_RUN_MEMORIES + 1,
  });
  const row = rows.find(
    (fact) => fact.id === reference.factId && fact.version_id === reference.versionId,
  );
  if (!row) throw new ConversationAccessError();
  return row;
}
async function currentReference(
  connection: SqlConnection,
  run: AdmittedRun,
  reference: GroupMemoryReference,
) {
  const { task, target } = run;
  if (!task.group_id || !task.group_grant_id) throw new ConversationAccessError();
  const row = (
    await connection.query<MemoryRow>(
      `SELECT ${memoryRowColumns} FROM ${memoryRowTables}
    WHERE m.workspace_id=$1 AND m.group_id=$2 AND m.conversation_id=$3 AND v.id=$4 AND v.source_event_id=$5`,
      [
        task.workspace_id,
        task.group_id,
        task.conversation_id,
        reference.memoryVersionId,
        reference.sourceEventId,
      ],
    )
  ).rows[0];
  if (
    !row ||
    Number(row.source_creation_sequence) < target.lowerBound ||
    Number(row.source_creation_sequence) > Number(task.trigger_sequence)
  )
    throw new ConversationAccessError();
  const source = await target.conversation.sourceForMemory(row.source_message_id);
  try {
    return projectCurrentMemory(row, source);
  } catch (error) {
    if (error instanceof MemoryAccessError) throw new ConversationAccessError();
    throw error;
  }
}
export async function selectRunMemoryContribution(
  connection: SqlConnection,
  runId: string,
  now: () => Date = () => new Date(),
): Promise<RunMemoryContribution> {
  const run = await runSource(connection, runId, now),
    { task, target } = run;
  if (task.status !== 'queued') throw new ConversationAccessError();
  const rows =
    task.group_id && task.group_grant_id
      ? await selectCurrentMemoryRows(
          connection,
          {
            workspaceId: task.workspace_id,
            groupId: task.group_id,
            conversationId: task.conversation_id,
            lowerBound: target.lowerBound,
            horizon: Number(task.trigger_sequence),
          },
          { limit: MAX_RUN_MEMORIES + 1 },
        )
      : [];
  const privateRows = await selectCurrentPrivateMemoryRows(
    connection,
    { workspaceId: task.workspace_id, botId: task.bot_id },
    { limit: MAX_RUN_MEMORIES + 1 },
  );
  const factRows = await selectApprovedFactRows(connection, {
    workspaceId: task.workspace_id,
    ...(task.group_id ? { groupId: task.group_id } : {}),
    botId: task.bot_id,
    includeWorkspace: true,
    limit: MAX_RUN_MEMORIES + 1,
  });
  if (rows.length + privateRows.length + factRows.length > MAX_RUN_MEMORIES)
    throw new MemoryContextLimitError();
  const groupReferences = rows.map((row) =>
    Object.freeze({
      kind: 'group' as const,
      memoryVersionId: row.version_id,
      sourceEventId: row.source_event_id,
    }),
  );
  const privateReferences = privateRows.map((row) =>
    Object.freeze({
      kind: 'bot-private' as const,
      privateMemoryId: row.id,
      sourceEventId: row.source_event_id,
    }),
  );
  const factReferences = factRows.map((row) =>
    Object.freeze({
      kind: 'approved-fact' as const,
      factId: row.id,
      versionId: row.version_id,
    }),
  );
  const references = [...groupReferences, ...privateReferences, ...factReferences];
  const memories = [];
  for (const reference of groupReferences)
    memories.push(await currentReference(connection, run, reference));
  const privateMemories = [];
  for (const reference of privateReferences)
    privateMemories.push(await currentPrivateReference(connection, run, reference));
  const facts = factRows.map(projectApprovedFact);
  const messages: Array<{ role: 'user'; content: string }> = [];
  if (memories.length)
    messages.push({ role: 'user', content: JSON.stringify({ kind: 'group_memories', memories }) });
  if (privateMemories.length)
    messages.push({
      role: 'user',
      content: JSON.stringify({ kind: 'bot_private_memories', memories: privateMemories }),
    });
  if (facts.length)
    messages.push({
      role: 'user',
      content: JSON.stringify({ kind: 'approved_facts', memories: facts }),
    });
  const bytes = messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
  if (bytes > 1048576) throw new MemoryContextLimitError();
  return Object.freeze({
    runId: task.id,
    references: Object.freeze(references),
    messages: Object.freeze(messages.map((message) => Object.freeze(message))),
    itemCount: memories.length + privateMemories.length + facts.length,
    bytes,
  });
}
export async function persistRunMemoryReferences(
  connection: SqlConnection,
  contribution: RunMemoryContribution,
  now: () => Date = () => new Date(),
) {
  const run = await runSource(connection, contribution.runId, now);
  if (run.task.status !== 'running') throw new ConversationAccessError();
  for (const reference of contribution.references) {
    if (reference.kind === 'group') {
      await currentReference(connection, run, reference);
      await connection.query(
        'INSERT INTO run_memory_references(run_id,memory_version_id,source_event_id,selected_at) VALUES($1,$2,$3,$4)',
        [run.task.id, reference.memoryVersionId, reference.sourceEventId, now()],
      );
    } else if (reference.kind === 'bot-private') {
      await currentPrivateReference(connection, run, reference);
      await connection.query(
        'INSERT INTO run_private_memory_references(run_id,private_memory_id,source_event_id,selected_at) VALUES($1,$2,$3,$4)',
        [run.task.id, reference.privateMemoryId, reference.sourceEventId, now()],
      );
    } else {
      await currentApprovedFact(connection, run, reference);
      await connection.query(
        'INSERT INTO run_approved_fact_references(run_id,fact_id,version_id,selected_at) VALUES($1,$2,$3,$4)',
        [run.task.id, reference.factId, reference.versionId, now()],
      );
    }
  }
}
export async function assertRunMemoryReferencesCurrent(
  connection: SqlConnection,
  runId: string,
  now: () => Date = () => new Date(),
) {
  const run = await runSource(connection, runId, now);
  if (run.task.status !== 'running') throw new ConversationAccessError();
  const references = (
    await connection.query<{ memory_version_id: string; source_event_id: string }>(
      'SELECT memory_version_id,source_event_id FROM run_memory_references WHERE run_id=$1 ORDER BY memory_version_id LIMIT $2',
      [run.task.id, MAX_RUN_MEMORIES + 1],
    )
  ).rows;
  const privateReferences = (
    await connection.query<{ private_memory_id: string; source_event_id: string }>(
      'SELECT private_memory_id,source_event_id FROM run_private_memory_references WHERE run_id=$1 ORDER BY private_memory_id LIMIT $2',
      [run.task.id, MAX_RUN_MEMORIES + 1],
    )
  ).rows;
  if (references.length + privateReferences.length > MAX_RUN_MEMORIES)
    throw new ConversationAccessError();
  if (!references.length && !privateReferences.length) return;
  if (references.length && (!run.task.group_id || !run.task.group_grant_id))
    throw new ConversationAccessError();
  // Stream publication rechecks the bounded manifest in one query. It neither
  // rematerializes all source bodies nor adds memories saved after this claim.
  if (references.length) {
    const current = await connection.query(
      `SELECT r.memory_version_id FROM run_memory_references r
      JOIN memory_versions v ON v.id=r.memory_version_id AND v.source_event_id=r.source_event_id
      JOIN group_memories m ON m.id=v.memory_id
      JOIN conversation_events e ON e.id=v.source_event_id AND e.conversation_id=m.conversation_id AND e.message_id=v.source_message_id
      JOIN conversation_events o ON o.id=v.source_creation_event_id AND o.conversation_id=m.conversation_id AND o.message_id=e.message_id
      LEFT JOIN conversation_events later ON later.conversation_id=e.conversation_id AND later.message_id=e.message_id AND later.sequence>e.sequence
      LEFT JOIN message_purges p ON p.workspace_id=m.workspace_id AND p.conversation_id=m.conversation_id AND p.message_id=e.message_id
      WHERE r.run_id=$1 AND m.workspace_id=$2 AND m.group_id=$3 AND m.conversation_id=$4
        AND o.sequence>=$5 AND o.sequence<=$6 AND o.sequence=v.source_creation_sequence
        AND o.event_type IN ('message.created','bot.message.created')
        AND e.event_type IN ('message.created','message.edited','bot.message.created') AND e.body IS NOT NULL
        AND later.id IS NULL AND p.message_id IS NULL LIMIT $7`,
      [
        run.task.id,
        run.task.workspace_id,
        run.task.group_id,
        run.task.conversation_id,
        run.target.lowerBound,
        Number(run.task.trigger_sequence),
        MAX_RUN_MEMORIES + 1,
      ],
    );
    if (current.rows.length !== references.length) throw new ConversationAccessError();
  }
  if (privateReferences.length) {
    const currentPrivate = await connection.query(
      `SELECT r.private_memory_id FROM run_private_memory_references r
      JOIN bot_private_memories p ON p.id=r.private_memory_id AND p.source_event_id=r.source_event_id
      JOIN memory_versions v ON v.id=p.source_memory_version_id AND v.memory_id=p.source_memory_id
      JOIN group_memories m ON m.id=p.source_memory_id
      JOIN conversation_events e ON e.id=v.source_event_id AND e.conversation_id=m.conversation_id AND e.message_id=v.source_message_id
      JOIN conversation_events o ON o.id=v.source_creation_event_id AND o.conversation_id=m.conversation_id AND o.message_id=e.message_id
      LEFT JOIN conversation_events later ON later.conversation_id=e.conversation_id AND later.message_id=e.message_id AND later.sequence>e.sequence
      LEFT JOIN message_purges purge ON purge.workspace_id=m.workspace_id AND purge.conversation_id=m.conversation_id AND purge.message_id=e.message_id
      WHERE r.run_id=$1 AND p.workspace_id=$2 AND p.bot_id=$3 AND ${privateMemoryCurrentWhere.replaceAll('\n        ', ' ')} LIMIT $4`,
      [run.task.id, run.task.workspace_id, run.task.bot_id, MAX_RUN_MEMORIES + 1],
    );
    if (currentPrivate.rows.length !== privateReferences.length)
      throw new ConversationAccessError();
  }
  const factReferences = (
    await connection.query<{ fact_id: string; version_id: string }>(
      'SELECT fact_id,version_id FROM run_approved_fact_references WHERE run_id=$1 ORDER BY fact_id LIMIT $2',
      [run.task.id, MAX_RUN_MEMORIES + 1],
    )
  ).rows;
  if (factReferences.length) {
    const currentFacts = await connection.query(
      `SELECT r.fact_id FROM run_approved_fact_references r
       JOIN approved_memory_facts f ON f.id=r.fact_id AND f.version_id=r.version_id AND f.workspace_id=$2
       JOIN memory_candidates c ON c.id=f.candidate_id
       JOIN conversation_events e ON e.id=c.output_event_id AND e.body IS NOT NULL
       LEFT JOIN message_purges p ON p.workspace_id=f.workspace_id AND p.message_id=e.message_id
       WHERE r.run_id=$1 AND p.message_id IS NULL LIMIT $3`,
      [run.task.id, run.task.workspace_id, MAX_RUN_MEMORIES + 1],
    );
    if (currentFacts.rows.length !== factReferences.length) throw new ConversationAccessError();
  }
}

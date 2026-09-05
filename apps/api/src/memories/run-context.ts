import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { ConversationAccessError, conversationUuid } from '../conversations/service.js';
import { admitTaskTarget } from '../tasks/admission.js';
import {
  memoryRowColumns,
  memoryRowTables,
  projectCurrentMemory,
  selectCurrentMemoryRows,
} from './current.js';
import { MemoryAccessError, type MemoryRow } from './types.js';

export class MemoryContextLimitError extends Error {}
export const MAX_RUN_MEMORIES = 100;
interface MemoryReference {
  readonly memoryVersionId: string;
  readonly sourceEventId: string;
}
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
async function currentReference(
  connection: SqlConnection,
  run: AdmittedRun,
  reference: MemoryReference,
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
  if (rows.length > MAX_RUN_MEMORIES) throw new MemoryContextLimitError();
  const references = rows.map((row) =>
    Object.freeze({ memoryVersionId: row.version_id, sourceEventId: row.source_event_id }),
  );
  const memories = [];
  for (const reference of references)
    memories.push(await currentReference(connection, run, reference));
  const content = memories.length ? JSON.stringify({ kind: 'group_memories', memories }) : '';
  const bytes = Buffer.byteLength(content);
  if (bytes > 1048576) throw new MemoryContextLimitError();
  return Object.freeze({
    runId: task.id,
    references: Object.freeze(references),
    messages: Object.freeze(content ? [Object.freeze({ role: 'user' as const, content })] : []),
    itemCount: memories.length,
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
    await currentReference(connection, run, reference);
    await connection.query(
      'INSERT INTO run_memory_references(run_id,memory_version_id,source_event_id,selected_at) VALUES($1,$2,$3,$4)',
      [run.task.id, reference.memoryVersionId, reference.sourceEventId, now()],
    );
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
  if (references.length > MAX_RUN_MEMORIES) throw new ConversationAccessError();
  if (!references.length) return;
  if (!run.task.group_id || !run.task.group_grant_id) throw new ConversationAccessError();
  // Stream publication rechecks the bounded manifest in one query. It neither
  // rematerializes all source bodies nor adds memories saved after this claim.
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

import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { appendPausedRunState } from '../conversations/append-event.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { conversationUuid, type ConversationAccess } from '../conversations/service.js';
import { TaskAccessError, TaskConflictError, TaskInputError } from './errors.js';
import type { TaskStatus } from './service.js';

export interface PauseCommand {
  idempotencyKey: string;
  expectedRunId: string;
}
export interface PauseReceipt {
  commandId: string;
  taskId: string;
  rootTaskId: string;
  runId: string;
  attempt: number;
  checkpointId: string;
  pausedAt: Date;
  affectedTaskCount: number;
  affectedRunCount: number;
}
type CommandRow = {
  id: string;
  task_id: string;
  root_task_id: string;
  expected_run_id: string;
  attempt: number;
  paused_at: Date;
  affected_task_count: number;
  affected_run_count: number;
};
type TreeTask = {
  id: string;
  parent_task_id: string | null;
  root_task_id: string;
  execution_user_id: string;
  status: TaskStatus;
};
type CurrentRun = {
  id: string;
  task_id: string;
  attempt: number;
  status: TaskStatus;
  finished_at: Date | null;
};

function receipt(row: CommandRow, checkpointId: string): PauseReceipt {
  return {
    commandId: row.id,
    taskId: row.task_id,
    rootTaskId: row.root_task_id,
    runId: row.expected_run_id,
    attempt: row.attempt,
    checkpointId,
    pausedAt: row.paused_at,
    affectedTaskCount: row.affected_task_count,
    affectedRunCount: row.affected_run_count,
  };
}

export function pauseCommand(input: unknown): PauseCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskInputError();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['idempotencyKey', 'expectedRunId'].includes(key)) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey)
  )
    throw new TaskInputError();
  return {
    idempotencyKey: value.idempotencyKey,
    expectedRunId: conversationUuid(value.expectedRunId),
  };
}

// Caller owns BEGIN/COMMIT. Current inspection takes the established
// workspace/group/direct-Bot/conversation locks before any Task or Run lock.
export async function pauseTask(
  connection: SqlConnection,
  access: ConversationAccess,
  taskId: string,
  command: PauseCommand,
  now: () => Date,
): Promise<PauseReceipt> {
  const conversation = await ConversationTransaction.lock(connection, access, now, 'inspect');
  const selected = (
    await connection.query<TreeTask>(
      'SELECT id,parent_task_id,root_task_id,execution_user_id,status FROM tasks WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',
      [taskId, access.workspaceId, access.conversationId],
    )
  ).rows[0];
  if (
    !selected ||
    (selected.execution_user_id !== access.actorUserId &&
      conversation.groupRole !== 'owner' &&
      conversation.groupRole !== 'admin')
  )
    throw new TaskAccessError();

  await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [selected.root_task_id]);
  const tree = (
    await connection.query<TreeTask>(
      'SELECT id,parent_task_id,root_task_id,execution_user_id,status FROM tasks WHERE root_task_id=$1 AND workspace_id=$2 AND conversation_id=$3 ORDER BY id',
      [selected.root_task_id, access.workspaceId, access.conversationId],
    )
  ).rows;
  const children = new Map<string, TreeTask[]>();
  for (const task of tree)
    if (task.parent_task_id) {
      const siblings = children.get(task.parent_task_id) ?? [];
      siblings.push(task);
      children.set(task.parent_task_id, siblings);
    }
  const subtree = [selected];
  const visited = new Set([selected.id]);
  for (let index = 0; index < subtree.length; index++)
    for (const child of children.get(subtree[index]!.id) ?? []) {
      if (visited.has(child.id)) throw new Error('Invalid retained Task tree');
      visited.add(child.id);
      subtree.push(child);
    }
  subtree.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const task of subtree)
    if (task.id !== selected.root_task_id)
      await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [task.id]);
  const runs = new Map<string, CurrentRun>();
  for (const task of subtree) {
    const run = (
      await connection.query<CurrentRun>(
        'SELECT id,task_id,attempt,status,finished_at FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE',
        [task.id],
      )
    ).rows[0];
    if (!run || run.status !== task.status) throw new Error('Task and current Run state differ');
    runs.set(task.id, run);
  }
  const current = runs.get(taskId)!;
  const prior = (
    await connection.query<CommandRow>(
      'SELECT * FROM task_pause_commands WHERE task_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
      [taskId, access.actorUserId, command.idempotencyKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.expected_run_id !== command.expectedRunId) throw new TaskConflictError();
    const checkpoint = (
      await connection.query<{ id: string }>(
        'SELECT id FROM task_run_pause_checkpoints WHERE run_id=$1 ORDER BY paused_at LIMIT 1',
        [prior.expected_run_id],
      )
    ).rows[0];
    if (!checkpoint) throw new Error('Pause receipt is missing its checkpoint');
    return receipt(prior, checkpoint.id);
  }
  if (current.id !== command.expectedRunId) throw new TaskConflictError('task_pause_run_conflict');
  if (!['queued', 'running', 'paused'].includes(selected.status))
    throw new TaskConflictError('task_pause_state_conflict');

  const affected =
    selected.status === 'paused'
      ? []
      : subtree.filter((task) => task.status === 'queued' || task.status === 'running');
  const occurredAt = now();
  const pausedAt = selected.status === 'paused' ? current.finished_at! : occurredAt;
  const row: CommandRow = {
    id: randomUUID(),
    task_id: taskId,
    root_task_id: selected.root_task_id,
    expected_run_id: current.id,
    attempt: current.attempt,
    paused_at: pausedAt,
    affected_task_count: affected.length,
    affected_run_count: affected.length,
  };
  const checkpointId =
    selected.status === 'paused'
      ? (
          await connection.query<{ id: string }>(
            'SELECT id FROM task_run_pause_checkpoints WHERE run_id=$1',
            [current.id],
          )
        ).rows[0]!.id
      : randomUUID();
  await connection.query(
    'INSERT INTO task_pause_commands(id,task_id,root_task_id,actor_user_id,idempotency_key,expected_run_id,attempt,paused_at,affected_task_count,affected_run_count,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      row.id,
      taskId,
      row.root_task_id,
      access.actorUserId,
      command.idempotencyKey,
      current.id,
      current.attempt,
      pausedAt,
      affected.length,
      affected.length,
      occurredAt,
    ],
  );
  for (const task of affected) {
    const run = runs.get(task.id)!;
    const endByte =
      (
        await connection.query<{ end_byte: number }>(
          'SELECT end_byte FROM task_run_partial_outputs WHERE run_id=$1',
          [run.id],
        )
      ).rows[0]?.end_byte ?? 0;
    const runCheckpointId = task.id === selected.id ? checkpointId : randomUUID();
    await connection.query(
      'INSERT INTO task_run_pauses(run_id,command_id,previous_status,paused_at) VALUES($1,$2,$3,$4)',
      [run.id, row.id, run.status, pausedAt],
    );
    await connection.query(
      "INSERT INTO task_run_pause_checkpoints(id,run_id,command_id,strategy,schema_version,previous_status,paused_at,end_byte) VALUES($1,$2,$3,'restart_from_task_input_v1',1,$4,$5,$6)",
      [runCheckpointId, run.id, row.id, run.status, pausedAt, endByte],
    );
    await connection.query("UPDATE task_runs SET status='paused',finished_at=$2 WHERE id=$1", [
      run.id,
      pausedAt,
    ]);
  }
  for (const task of affected) {
    const run = runs.get(task.id)!;
    const runCheckpoint = (
      await connection.query<{ id: string }>(
        'SELECT id FROM task_run_pause_checkpoints WHERE run_id=$1',
        [run.id],
      )
    ).rows[0]!;
    await connection.query("UPDATE tasks SET status='paused' WHERE id=$1", [task.id]);
    await connection.query(
      "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.paused',$2,$3,$4::jsonb)",
      [
        randomUUID(),
        access.actorUserId,
        pausedAt,
        JSON.stringify({
          workspaceId: access.workspaceId,
          conversationId: access.conversationId,
          taskId: task.id,
          runId: run.id,
          attempt: run.attempt,
          pauseCommandId: row.id,
          checkpointId: runCheckpoint.id,
          requestedTaskId: taskId,
          rootTaskId: row.root_task_id,
        }),
      ],
    );
    await appendPausedRunState(connection, run.id, now);
  }
  return receipt(row, checkpointId);
}

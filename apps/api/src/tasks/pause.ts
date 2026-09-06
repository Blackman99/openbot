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
type SelectedTask = {
  id: string;
  root_task_id: string;
  execution_user_id: string;
  status: TaskStatus;
};
type CurrentRun = {
  id: string;
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

// First COL-08 slice: pause the selected queued Task only. Running pause,
// subtree walk, and resume stay later slices. Caller owns BEGIN/COMMIT.
export async function pauseTask(
  connection: SqlConnection,
  access: ConversationAccess,
  taskId: string,
  command: PauseCommand,
  now: () => Date,
): Promise<PauseReceipt> {
  const conversation = await ConversationTransaction.lock(connection, access, now, 'inspect');
  const selected = (
    await connection.query<SelectedTask>(
      'SELECT id,root_task_id,execution_user_id,status FROM tasks WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',
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
  if (selected.id !== selected.root_task_id)
    await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [selected.id]);
  const run = (
    await connection.query<CurrentRun>(
      'SELECT id,attempt,status,finished_at FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE',
      [selected.id],
    )
  ).rows[0];
  if (!run || run.status !== selected.status) throw new Error('Task and current Run state differ');

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
        'SELECT id FROM task_run_pause_checkpoints WHERE command_id=$1 AND run_id=$2',
        [prior.id, prior.expected_run_id],
      )
    ).rows[0];
    if (!checkpoint) throw new Error('Pause receipt is missing its checkpoint');
    return receipt(prior, checkpoint.id);
  }
  if (run.id !== command.expectedRunId) throw new TaskConflictError('task_pause_run_conflict');
  if (!['queued', 'paused'].includes(selected.status))
    throw new TaskConflictError('task_pause_state_conflict');

  const occurredAt = now();
  const pausedAt = selected.status === 'paused' ? run.finished_at! : occurredAt;
  const affected = selected.status === 'paused' ? 0 : 1;
  const row: CommandRow = {
    id: randomUUID(),
    task_id: taskId,
    root_task_id: selected.root_task_id,
    expected_run_id: run.id,
    attempt: run.attempt,
    paused_at: pausedAt,
    affected_task_count: affected,
    affected_run_count: affected,
  };
  const checkpointId =
    selected.status === 'paused'
      ? (
          await connection.query<{ id: string }>(
            'SELECT id FROM task_run_pause_checkpoints WHERE run_id=$1',
            [run.id],
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
      run.id,
      run.attempt,
      pausedAt,
      affected,
      affected,
      occurredAt,
    ],
  );
  if (selected.status === 'queued') {
    await connection.query(
      'INSERT INTO task_run_pauses(run_id,command_id,previous_status,paused_at) VALUES($1,$2,$3,$4)',
      [run.id, row.id, run.status, pausedAt],
    );
    await connection.query(
      "INSERT INTO task_run_pause_checkpoints(id,run_id,command_id,strategy,schema_version,previous_status,paused_at,end_byte) VALUES($1,$2,$3,'restart_from_task_input_v1',1,$4,$5,0)",
      [checkpointId, run.id, row.id, run.status, pausedAt],
    );
    await connection.query("UPDATE task_runs SET status='paused',finished_at=$2 WHERE id=$1", [
      run.id,
      pausedAt,
    ]);
    await connection.query("UPDATE tasks SET status='paused' WHERE id=$1", [selected.id]);
    await connection.query(
      "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.paused',$2,$3,$4::jsonb)",
      [
        randomUUID(),
        access.actorUserId,
        pausedAt,
        JSON.stringify({
          workspaceId: access.workspaceId,
          conversationId: access.conversationId,
          taskId: selected.id,
          runId: run.id,
          attempt: run.attempt,
          pauseCommandId: row.id,
          checkpointId,
          rootTaskId: row.root_task_id,
        }),
      ],
    );
    await appendPausedRunState(connection, run.id, now);
  }
  return receipt(row, checkpointId);
}

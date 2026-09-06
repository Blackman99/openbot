import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { appendCancelledRunState } from '../conversations/append-event.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { conversationUuid, type ConversationAccess } from '../conversations/service.js';
import { resumeParentAfterChild } from './delegate-child.js';
import { TaskAccessError, TaskConflictError, TaskInputError } from './errors.js';
import { reconcileRunTokenReservation } from './token-budget-store.js';
import { reconcileRunCostReservation } from './cost-budget-store.js';
import type { TaskStatus } from './service.js';

export interface CancellationCommand {
  idempotencyKey: string;
  expectedRunId: string;
}
export interface CancellationReceipt {
  commandId: string;
  taskId: string;
  rootTaskId: string;
  runId: string;
  attempt: number;
  cancelledAt: Date;
  affectedTaskCount: number;
  affectedRunCount: number;
}
type CommandRow = {
  id: string;
  task_id: string;
  root_task_id: string;
  expected_run_id: string;
  attempt: number;
  cancelled_at: Date;
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
function receipt(row: CommandRow): CancellationReceipt {
  return {
    commandId: row.id,
    taskId: row.task_id,
    rootTaskId: row.root_task_id,
    runId: row.expected_run_id,
    attempt: row.attempt,
    cancelledAt: row.cancelled_at,
    affectedTaskCount: row.affected_task_count,
    affectedRunCount: row.affected_run_count,
  };
}
export function cancellationCommand(input: unknown): CancellationCommand {
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

// The caller owns BEGIN/COMMIT. Current inspection takes the established
// workspace/group/direct-Bot/conversation locks before any Task or Run lock.
export async function cancelTask(
  connection: SqlConnection,
  access: ConversationAccess,
  taskId: string,
  command: CancellationCommand,
  now: () => Date,
): Promise<CancellationReceipt> {
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

  // The root lock serializes overlapping subtree commands. Lock every selected
  // Task before any current Run; terminal intermediate Tasks remain traversable.
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
      'SELECT * FROM task_cancel_commands WHERE task_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
      [taskId, access.actorUserId, command.idempotencyKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.expected_run_id !== command.expectedRunId) throw new TaskConflictError();
    return receipt(prior);
  }
  if (current.id !== command.expectedRunId) throw new TaskConflictError('task_cancel_run_conflict');
  if (!['queued', 'running', 'waiting_child', 'cancelled'].includes(selected.status))
    throw new TaskConflictError('task_cancel_state_conflict');
  const affected =
    selected.status === 'cancelled'
      ? []
      : subtree.filter(
          (task) =>
            task.status === 'queued' ||
            task.status === 'running' ||
            task.status === 'waiting_child',
        );
  const occurredAt = now();
  const row: CommandRow = {
    id: randomUUID(),
    task_id: taskId,
    root_task_id: selected.root_task_id,
    expected_run_id: current.id,
    attempt: current.attempt,
    cancelled_at: selected.status === 'cancelled' ? current.finished_at! : occurredAt,
    affected_task_count: affected.length,
    affected_run_count: affected.length,
  };
  await connection.query(
    'INSERT INTO task_cancel_commands(id,task_id,root_task_id,actor_user_id,idempotency_key,expected_run_id,attempt,cancelled_at,affected_task_count,affected_run_count,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      row.id,
      taskId,
      row.root_task_id,
      access.actorUserId,
      command.idempotencyKey,
      current.id,
      current.attempt,
      row.cancelled_at,
      affected.length,
      affected.length,
      occurredAt,
    ],
  );
  for (const task of affected) {
    const run = runs.get(task.id)!;
    await connection.query(
      'INSERT INTO task_run_cancellations(run_id,command_id,previous_status,cancelled_at) VALUES($1,$2,$3,$4)',
      [run.id, row.id, run.status, row.cancelled_at],
    );
    await connection.query("UPDATE task_runs SET status='cancelled',finished_at=$2 WHERE id=$1", [
      run.id,
      row.cancelled_at,
    ]);
    const group = (
      await connection.query<{ group_id: string | null }>(
        'SELECT c.group_id FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=$1',
        [task.id],
      )
    ).rows[0];
    const target = {
      runId: run.id,
      taskId: task.id,
      workspaceId: access.workspaceId,
      groupId: group?.group_id ?? null,
    };
    await reconcileRunTokenReservation(connection, target, { inputTokens: 0, outputTokens: 0 });
    await reconcileRunCostReservation(connection, target, 0);
  }
  for (const task of affected) {
    const run = runs.get(task.id)!;
    await connection.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [task.id]);
    await connection.query(
      "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.cancelled',$2,$3,$4::jsonb)",
      [
        randomUUID(),
        access.actorUserId,
        row.cancelled_at,
        JSON.stringify({
          workspaceId: access.workspaceId,
          conversationId: access.conversationId,
          taskId: task.id,
          runId: run.id,
          attempt: run.attempt,
          cancelCommandId: row.id,
          requestedTaskId: taskId,
          rootTaskId: row.root_task_id,
        }),
      ],
    );
    await appendCancelledRunState(connection, run.id, now);
  }
  for (const task of affected) await resumeParentAfterChild(connection, task.id, occurredAt);
  return receipt(row);
}

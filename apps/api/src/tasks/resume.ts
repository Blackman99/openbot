import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { BotBinding } from '../bots/service.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { conversationUuid, type ConversationAccess } from '../conversations/service.js';
import { admitUsableModel } from '../providers/postgres-model-admission.js';
import { admitTaskTarget } from './admission.js';
import { TaskAccessError, TaskConflictError, TaskInputError } from './errors.js';
import { loadAttemptChain, writeNextAttempt } from './next-attempt.js';
import { effectiveRetryPolicy, type NextAttemptPlan } from './retry-schedule.js';
import type { TaskStatus } from './service.js';
import { lockTaskAncestry } from './tree.js';

export interface ResumeCommand {
  idempotencyKey: string;
  expectedRunId: string;
}
export interface ResumeReceipt {
  commandId: string;
  taskId: string;
  runId: string;
  attempt: number;
  sourceRunId: string;
  checkpointId: string;
  resumedAt: Date;
  affectedTaskCount: number;
  affectedRunCount: number;
}
type CommandRow = {
  id: string;
  task_id: string;
  expected_run_id: string;
  run_id: string;
  attempt: number;
  checkpoint_id: string;
  resumed_at: Date;
  affected_task_count: number;
  affected_run_count: number;
};
type SelectedTask = {
  id: string;
  execution_user_id: string;
  bot_version_id: string;
  group_grant_id: string | null;
  status: TaskStatus;
};
type CurrentRun = {
  id: string;
  attempt: number;
  status: TaskStatus;
};

export function planManualResume(input: {
  binding: BotBinding;
  sourceRunId: string;
  chainRootRunId: string;
  chainAttemptOrdinal: number;
  chainLimitSnapshot: number;
  now: Date;
}): NextAttemptPlan {
  return {
    origin: 'manual_resume',
    reason: 'manual_resume',
    binding: input.binding,
    previousBinding: input.binding,
    notBefore: input.now,
    delayMs: 0,
    jitterMs: 0,
    chainRootRunId: input.chainRootRunId,
    previousRunId: input.sourceRunId,
    chainAttemptOrdinal: input.chainAttemptOrdinal,
    chainLimitSnapshot: input.chainLimitSnapshot,
    modelAttemptOrdinal: 1,
  };
}

function receipt(row: CommandRow): ResumeReceipt {
  return {
    commandId: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    attempt: row.attempt,
    sourceRunId: row.expected_run_id,
    checkpointId: row.checkpoint_id,
    resumedAt: row.resumed_at,
    affectedTaskCount: row.affected_task_count,
    affectedRunCount: row.affected_run_count,
  };
}

export function resumeCommand(input: unknown): ResumeCommand {
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

// Resume is only the original execution human. It creates one new queued Run
// through writeNextAttempt and never mutates the interrupted paused Run.
export async function resumeTask(
  connection: SqlConnection,
  access: ConversationAccess,
  taskId: string,
  command: ResumeCommand,
  now: () => Date,
): Promise<ResumeReceipt> {
  await ConversationTransaction.lock(connection, access, now, 'inspect');
  const selected = (
    await connection.query<SelectedTask>(
      'SELECT id,execution_user_id,bot_version_id,group_grant_id,status FROM tasks WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',
      [taskId, access.workspaceId, access.conversationId],
    )
  ).rows[0];
  if (!selected || selected.execution_user_id !== access.actorUserId) throw new TaskAccessError();

  const prior = (
    await connection.query<CommandRow>(
      'SELECT * FROM task_resume_commands WHERE task_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
      [taskId, access.actorUserId, command.idempotencyKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.expected_run_id !== command.expectedRunId) throw new TaskConflictError();
    return receipt(prior);
  }

  const activeAncestry = await lockTaskAncestry(connection, taskId, { allowPausedTarget: true });
  const latest = (
    await connection.query<CurrentRun>(
      'SELECT id,attempt,status FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE',
      [taskId],
    )
  ).rows[0];
  if (!latest) throw new TaskAccessError();

  const existing = (
    await connection.query<CommandRow>(
      'SELECT * FROM task_resume_commands WHERE task_id=$1 AND expected_run_id=$2 AND affected_task_count>0 ORDER BY created_at LIMIT 1',
      [taskId, command.expectedRunId],
    )
  ).rows[0];
  const occurredAt = now();
  if (existing) {
    const row: CommandRow = {
      id: randomUUID(),
      task_id: taskId,
      expected_run_id: existing.expected_run_id,
      run_id: existing.run_id,
      attempt: existing.attempt,
      checkpoint_id: existing.checkpoint_id,
      resumed_at: existing.resumed_at,
      affected_task_count: 0,
      affected_run_count: 0,
    };
    await connection.query(
      'INSERT INTO task_resume_commands(id,task_id,actor_user_id,idempotency_key,expected_run_id,run_id,attempt,checkpoint_id,resumed_at,affected_task_count,affected_run_count,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        row.id,
        taskId,
        access.actorUserId,
        command.idempotencyKey,
        row.expected_run_id,
        row.run_id,
        row.attempt,
        row.checkpoint_id,
        row.resumed_at,
        0,
        0,
        occurredAt,
      ],
    );
    return receipt(row);
  }
  if (latest.id !== command.expectedRunId) throw new TaskConflictError('task_resume_run_conflict');
  if (selected.status !== 'paused' || latest.status !== 'paused')
    throw new TaskConflictError('task_resume_state_conflict');
  if (latest.attempt >= 2147483647) throw new TaskConflictError('task_attempt_exhausted');

  const checkpoint = (
    await connection.query<{ id: string }>(
      'SELECT id FROM task_run_pause_checkpoints WHERE run_id=$1',
      [latest.id],
    )
  ).rows[0];
  if (!checkpoint) throw new Error('Paused Run is missing its checkpoint');
  if (!activeAncestry) throw new TaskConflictError('task_resume_paused_ancestor');

  const target = await admitTaskTarget(
    connection,
    access,
    selected.group_grant_id,
    now,
    selected.bot_version_id,
  );
  const binding = target.configuration.modelBinding;
  await admitUsableModel(
    connection,
    { actorUserId: access.actorUserId, scope: binding.scope },
    { connectionId: binding.connectionId, expectedModelId: binding.modelId },
  );
  const chain = await loadAttemptChain(connection, taskId, latest.id);
  const policy = effectiveRetryPolicy(target.configuration.retryPolicy);
  const written = await writeNextAttempt(connection, {
    taskId,
    sourceRunId: latest.id,
    workspaceId: access.workspaceId,
    conversationId: access.conversationId,
    executionUserId: selected.execution_user_id,
    sourceAttempt: latest.attempt,
    plan: planManualResume({
      binding,
      sourceRunId: latest.id,
      chainRootRunId: chain.rootRunId,
      chainAttemptOrdinal: chain.attempts.length + 1,
      chainLimitSnapshot: policy.maxRunsPerChain,
      now: occurredAt,
    }),
    now: occurredAt,
  });
  if (!written.scheduled)
    throw new TaskConflictError(
      written.reason === 'cancelled' ? 'task_resume_paused_ancestor' : 'task_resume_state_conflict',
    );
  const next = (
    await connection.query<{ attempt: number }>('SELECT attempt FROM task_runs WHERE id=$1', [
      written.runId,
    ])
  ).rows[0]!;
  const row: CommandRow = {
    id: randomUUID(),
    task_id: taskId,
    expected_run_id: latest.id,
    run_id: written.runId,
    attempt: next.attempt,
    checkpoint_id: checkpoint.id,
    resumed_at: occurredAt,
    affected_task_count: 1,
    affected_run_count: 1,
  };
  await connection.query(
    'INSERT INTO task_resume_commands(id,task_id,actor_user_id,idempotency_key,expected_run_id,run_id,attempt,checkpoint_id,resumed_at,affected_task_count,affected_run_count,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      row.id,
      taskId,
      access.actorUserId,
      command.idempotencyKey,
      row.expected_run_id,
      row.run_id,
      row.attempt,
      row.checkpoint_id,
      row.resumed_at,
      1,
      1,
      occurredAt,
    ],
  );
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.resumed',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      access.actorUserId,
      occurredAt,
      JSON.stringify({
        workspaceId: access.workspaceId,
        conversationId: access.conversationId,
        taskId,
        resumeCommandId: row.id,
        sourceRunId: latest.id,
        runId: written.runId,
        attempt: next.attempt,
        checkpointId: checkpoint.id,
      }),
    ],
  );
  return receipt(row);
}

import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { conversationUuid, type ConversationAccess } from '../conversations/service.js';
import { admitUsableModel } from '../providers/postgres-model-admission.js';
import { admitTaskTarget } from './admission.js';
import { TaskAccessError, TaskConflictError, TaskInputError } from './errors.js';
import {
  EXECUTION_LIMIT_DIMENSIONS,
  loadEffectiveTaskLimits,
  loadTaskLimitSnapshot,
  type ExecutionLimitDimension,
} from './execution-limit-enforcement.js';
import { loadAttemptChain, writeNextAttempt } from './next-attempt.js';
import { effectiveRetryPolicy, type NextAttemptPlan } from './retry-schedule.js';
import type { TaskStatus } from './service.js';
import { lockTaskAncestry } from './tree.js';

export interface LimitGrantCommand {
  idempotencyKey: string;
  dimension: ExecutionLimitDimension;
  limit: number;
}
export interface LimitGrantReceipt {
  grantId: string;
  taskId: string;
  dimension: ExecutionLimitDimension;
  previousLimit: number;
  grantedLimit: number;
  runId: string | null;
  attempt: number | null;
}

export function planBudgetGrant(input: {
  binding: NextAttemptPlan['binding'];
  sourceRunId: string;
  chainRootRunId: string;
  chainAttemptOrdinal: number;
  chainLimitSnapshot: number;
  now: Date;
}): NextAttemptPlan {
  return {
    origin: 'budget_grant',
    reason: 'budget_grant',
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

export function limitGrantCommand(input: unknown): LimitGrantCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskInputError();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['idempotencyKey', 'dimension', 'limit'].includes(key)) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey) ||
    typeof value.dimension !== 'string' ||
    !EXECUTION_LIMIT_DIMENSIONS.includes(value.dimension as ExecutionLimitDimension) ||
    typeof value.limit !== 'number' ||
    !Number.isInteger(value.limit)
  )
    throw new TaskInputError();
  const dimension = value.dimension as ExecutionLimitDimension;
  const max =
    dimension === 'duration'
      ? 3_600_000
      : dimension === 'turns'
        ? 100
        : dimension === 'handoffs'
          ? 32
          : 8;
  const min = dimension === 'duration' ? 1 : 0;
  if (value.limit < min || value.limit > max) throw new TaskInputError();
  return { idempotencyKey: value.idempotencyKey, dimension, limit: value.limit };
}

async function requireWorkspaceManager(
  connection: SqlConnection,
  workspaceId: string,
  actorUserId: string,
) {
  const member = (
    await connection.query<{ role: string }>(
      "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','administrator')",
      [workspaceId, actorUserId],
    )
  ).rows[0];
  if (!member) throw new TaskAccessError();
}

function previousLimit(
  limits: NonNullable<Awaited<ReturnType<typeof loadEffectiveTaskLimits>>>,
  dimension: ExecutionLimitDimension,
) {
  if (dimension === 'duration') return limits.duration?.maxDurationMs;
  if (dimension === 'turns') return limits.turns?.maxTurns;
  if (dimension === 'delegationDepth') return limits.delegationDepth?.maxDelegationDepth;
  return limits.handoffs?.maxHandoffs ?? 0;
}

export async function grantTaskLimit(
  connection: SqlConnection,
  access: ConversationAccess,
  taskId: string,
  command: LimitGrantCommand,
  now: () => Date,
): Promise<LimitGrantReceipt> {
  await ConversationTransaction.lock(connection, access, now, 'inspect');
  const selected = (
    await connection.query<{
      id: string;
      execution_user_id: string;
      bot_version_id: string;
      group_grant_id: string | null;
      status: TaskStatus;
    }>(
      'SELECT id,execution_user_id,bot_version_id,group_grant_id,status FROM tasks WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',
      [taskId, access.workspaceId, access.conversationId],
    )
  ).rows[0];
  if (!selected) throw new TaskAccessError();
  if (selected.execution_user_id !== access.actorUserId)
    await requireWorkspaceManager(connection, access.workspaceId, access.actorUserId);
  const prior = (
    await connection.query<{
      id: string;
      dimension: ExecutionLimitDimension;
      previous_limit: string | number;
      granted_limit: string | number;
      created_at: Date;
    }>(
      'SELECT id,dimension,previous_limit,granted_limit,created_at FROM task_execution_limit_grants WHERE task_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
      [taskId, access.actorUserId, command.idempotencyKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.dimension !== command.dimension || Number(prior.granted_limit) !== command.limit)
      throw new TaskConflictError();
    const successor = (
      await connection.query<{ run_id: string; attempt: number }>(
        `SELECT r.id AS run_id, r.attempt
         FROM audit_events a
         JOIN task_runs r ON r.id::text=a.metadata->>'runId' AND r.task_id=$1
         WHERE a.event_type='task.queued'
           AND a.metadata->>'taskId'=$1
           AND a.metadata->>'origin'='budget_grant'
           AND a.occurred_at>=$2
         ORDER BY a.occurred_at DESC, r.attempt DESC
         LIMIT 1`,
        [taskId, prior.created_at],
      )
    ).rows[0];
    if (successor)
      return {
        grantId: prior.id,
        taskId,
        dimension: prior.dimension,
        previousLimit: Number(prior.previous_limit),
        grantedLimit: Number(prior.granted_limit),
        runId: successor.run_id,
        attempt: Number(successor.attempt),
      };
    const latest = (
      await connection.query<{ id: string; attempt: number; status: string }>(
        'SELECT id,attempt,status FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1',
        [taskId],
      )
    ).rows[0];
    return {
      grantId: prior.id,
      taskId,
      dimension: prior.dimension,
      previousLimit: Number(prior.previous_limit),
      grantedLimit: Number(prior.granted_limit),
      runId: latest?.status === 'queued' ? latest.id : null,
      attempt: latest?.status === 'queued' ? Number(latest.attempt) : null,
    };
  }
  if (!(await loadTaskLimitSnapshot(connection, taskId)))
    throw new TaskConflictError('task_limit_snapshot_missing');
  const effective = await loadEffectiveTaskLimits(connection, taskId);
  if (!effective) throw new TaskConflictError('task_limit_snapshot_missing');
  const previous = previousLimit(effective, command.dimension);
  if (previous === undefined || command.limit <= previous)
    throw new TaskConflictError('task_limit_grant_not_increased');
  const occurredAt = now();
  const grantId = randomUUID();
  await connection.query(
    `INSERT INTO task_execution_limit_grants(
      id,task_id,actor_user_id,idempotency_key,dimension,previous_limit,granted_limit,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      grantId,
      taskId,
      access.actorUserId,
      command.idempotencyKey,
      command.dimension,
      previous,
      command.limit,
      occurredAt,
    ],
  );
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.limit.granted',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      access.actorUserId,
      occurredAt,
      JSON.stringify({
        workspaceId: access.workspaceId,
        conversationId: access.conversationId,
        taskId,
        grantId,
        dimension: command.dimension,
        previousLimit: previous,
        grantedLimit: command.limit,
      }),
    ],
  );
  let runId: string | null = null,
    attempt: number | null = null;
  if (selected.status === 'waiting_budget') {
    const latest = (
      await connection.query<{ id: string; attempt: number; status: TaskStatus }>(
        'SELECT id,attempt,status FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE',
        [taskId],
      )
    ).rows[0];
    if (!latest) throw new TaskConflictError('task_limit_state_conflict');
    if (!(await lockTaskAncestry(connection, taskId, { allowPausedTarget: true })))
      throw new TaskConflictError('task_limit_paused_ancestor');
    if (latest.status === 'queued') {
      await connection.query("UPDATE tasks SET status='queued' WHERE id=$1", [taskId]);
      runId = latest.id;
      attempt = Number(latest.attempt);
    } else {
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
        plan: planBudgetGrant({
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
          written.reason === 'cancelled'
            ? 'task_limit_paused_ancestor'
            : 'task_limit_state_conflict',
        );
      runId = written.runId;
      attempt = (
        await connection.query<{ attempt: number }>('SELECT attempt FROM task_runs WHERE id=$1', [
          written.runId,
        ])
      ).rows[0]!.attempt;
    }
  }
  return {
    grantId,
    taskId,
    dimension: command.dimension,
    previousLimit: previous,
    grantedLimit: command.limit,
    runId,
    attempt,
  };
}

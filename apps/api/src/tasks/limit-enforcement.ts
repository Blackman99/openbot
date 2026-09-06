import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { appendWaitingBudgetRunState } from '../conversations/append-event.js';
import {
  crossedSoftThreshold,
  reachedHardLimit,
  type LimitDimension,
  type LimitSnapshot,
  type LimitUsage,
} from './limit-view.js';
import { loadEffectiveLimits, loadLimitUsage, loadSnapshot } from './limit-snapshot.js';

export async function loadEnforcedLimits(
  connection: SqlConnection,
  taskId: string,
  now: Date,
): Promise<{ snapshot: LimitSnapshot; effective: LimitSnapshot; usage: LimitUsage } | undefined> {
  const snapshot = await loadSnapshot(connection, taskId);
  if (!snapshot) return undefined;
  return {
    snapshot,
    effective: await loadEffectiveLimits(connection, taskId, snapshot),
    usage: await loadLimitUsage(connection, taskId, now),
  };
}

export async function shouldHoldNextRun(
  connection: SqlConnection,
  taskId: string,
  now: Date,
): Promise<LimitDimension | undefined> {
  const limits = await loadEnforcedLimits(connection, taskId, now);
  if (!limits) return undefined;
  if (reachedHardLimit(limits.usage.turns, limits.effective.turns)) return 'turns';
  if (limits.usage.depth > limits.effective.depth) return 'depth';
  if (
    reachedHardLimit(limits.usage.handoffs, limits.effective.handoffs) &&
    limits.usage.handoffs > 0
  )
    return 'handoffs';
  return undefined;
}

export async function holdTaskForBudget(
  connection: SqlConnection,
  input: {
    taskId: string;
    runId: string;
    workspaceId: string;
    conversationId: string;
    actorUserId: string;
    dimension: LimitDimension;
    now: Date;
  },
): Promise<boolean> {
  const limits = await loadEnforcedLimits(connection, input.taskId, input.now);
  if (!limits) return false;
  const usage = limitValue(limits.usage, input.dimension);
  const threshold = limitValue(limits.effective, input.dimension);
  const run = (
    await connection.query<{ status: string }>(
      'SELECT status FROM task_runs WHERE id=$1 FOR UPDATE',
      [input.runId],
    )
  ).rows[0];
  if (!run) return false;
  if (run.status === 'queued') {
    await connection.query(
      "UPDATE tasks SET status='waiting_budget' WHERE id=$1 AND status='queued'",
      [input.taskId],
    );
    const held = await connection.query(
      "UPDATE task_runs SET status='waiting_budget',finished_at=$2 WHERE id=$1 AND status='queued' RETURNING id",
      [input.runId, input.now],
    );
    if (!held.rows.length) return false;
    await appendWaitingBudgetRunState(connection, input.runId, () => input.now);
  } else {
    await connection.query(
      "UPDATE tasks SET status='waiting_budget' WHERE id=$1 AND status IN ('queued','running','failed','paused')",
      [input.taskId],
    );
  }
  await recordLimitEvent(connection, {
    taskId: input.taskId,
    kind: 'hard_limit',
    dimension: input.dimension,
    usage,
    threshold,
    now: input.now,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
    runId: input.runId,
  });
  return true;
}

export async function recordSoftLimitWarnings(
  connection: SqlConnection,
  input: {
    taskId: string;
    runId: string;
    workspaceId: string;
    conversationId: string;
    actorUserId: string;
    now: Date;
  },
) {
  const limits = await loadEnforcedLimits(connection, input.taskId, input.now);
  if (!limits) return;
  for (const dimension of ['durationMs', 'turns', 'depth', 'handoffs'] as const) {
    const usage = limitValue(limits.usage, dimension);
    const hard = limitValue(limits.effective, dimension);
    if (!crossedSoftThreshold(usage, hard)) continue;
    await recordLimitEvent(connection, {
      ...input,
      kind: 'soft_warning',
      dimension,
      usage,
      threshold: Math.floor(hard * 0.8),
    });
  }
}

async function recordLimitEvent(
  connection: SqlConnection,
  input: {
    taskId: string;
    runId: string;
    workspaceId: string;
    conversationId: string;
    actorUserId: string;
    kind: 'soft_warning' | 'hard_limit';
    dimension: LimitDimension;
    usage: number;
    threshold: number;
    now: Date;
  },
) {
  const inserted = await connection.query(
    `INSERT INTO task_limit_events(id,task_id,kind,dimension,usage,threshold,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(task_id,kind,dimension) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.taskId,
      input.kind,
      input.dimension,
      input.usage,
      input.threshold,
      input.now,
    ],
  );
  if (!inserted.rows.length) return;
  await connection.query(
    'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [
      randomUUID(),
      input.kind === 'soft_warning' ? 'task.limit.warning' : 'task.limit.held',
      input.actorUserId,
      input.now,
      JSON.stringify({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        runId: input.runId,
        dimension: input.dimension,
        usage: input.usage,
        threshold: input.threshold,
      }),
    ],
  );
}

function limitValue(
  limits: Pick<LimitSnapshot, 'durationMs' | 'turns' | 'depth' | 'handoffs'>,
  dimension: LimitDimension,
): number {
  if (dimension === 'durationMs') return limits.durationMs;
  if (dimension === 'turns') return limits.turns;
  if (dimension === 'depth') return limits.depth;
  return limits.handoffs;
}

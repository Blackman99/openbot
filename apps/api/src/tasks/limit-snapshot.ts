import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import {
  parseExecutionPolicy,
  type ExecutionLimitLayer,
  type ExecutionLimitPolicy,
} from './execution-limits.js';
import type { LimitDimension, LimitSnapshot, LimitUsage } from './limit-view.js';

export type { LimitDimension, LimitSnapshot, LimitUsage };
export interface TaskLimitView extends LimitSnapshot {
  usage: LimitUsage;
  warnings: Array<{
    kind: 'soft_warning' | 'hard_limit';
    dimension: LimitDimension;
    usage: number;
    threshold: number;
    createdAt: Date;
  }>;
}

export function readSubmitTaskPolicy(
  input: Record<string, unknown>,
): ExecutionLimitPolicy | undefined {
  if (input.policy === undefined) return undefined;
  return parseExecutionPolicy(input.policy);
}

export async function loadTaskLimitView(
  connection: SqlConnection,
  taskId: string,
  now: Date,
): Promise<TaskLimitView | undefined> {
  const snapshot = await loadSnapshot(connection, taskId);
  if (!snapshot) return undefined;
  const effective = await loadEffectiveLimits(connection, taskId, snapshot);
  const usage = await loadLimitUsage(connection, taskId, now);
  const warnings = (
    await connection.query<{
      kind: 'soft_warning' | 'hard_limit';
      dimension: LimitDimension;
      usage: number;
      threshold: number;
      created_at: Date;
    }>(
      'SELECT kind,dimension,usage,threshold,created_at FROM task_limit_events WHERE task_id=$1 ORDER BY created_at,dimension',
      [taskId],
    )
  ).rows.map((row) => ({
    kind: row.kind,
    dimension: row.dimension,
    usage: Number(row.usage),
    threshold: Number(row.threshold),
    createdAt: row.created_at,
  }));
  return { ...effective, usage, warnings };
}

export async function loadSnapshot(
  connection: SqlConnection,
  taskId: string,
): Promise<LimitSnapshot | undefined> {
  const row = (
    await connection.query<{
      max_duration_ms: string | number;
      duration_source: ExecutionLimitLayer;
      max_turns: number;
      turns_source: ExecutionLimitLayer;
      max_delegation_depth: number;
      delegation_depth_source: ExecutionLimitLayer;
      max_handoffs: number | null;
      handoffs_source: ExecutionLimitLayer | null;
    }>(
      `SELECT max_duration_ms,duration_source,max_turns,turns_source,max_delegation_depth,delegation_depth_source,max_handoffs,handoffs_source
       FROM task_execution_limit_snapshots WHERE task_id=$1`,
      [taskId],
    )
  ).rows[0];
  if (!row) return undefined;
  return {
    durationMs: Number(row.max_duration_ms),
    durationSource: row.duration_source,
    turns: Number(row.max_turns),
    turnsSource: row.turns_source,
    depth: Number(row.max_delegation_depth),
    depthSource: row.delegation_depth_source,
    handoffs: row.max_handoffs === null ? 32 : Number(row.max_handoffs),
    handoffsSource: row.handoffs_source ?? 'run',
  };
}

export async function loadEffectiveLimits(
  connection: SqlConnection,
  taskId: string,
  snapshot: LimitSnapshot,
): Promise<LimitSnapshot> {
  const grants = (
    await connection.query<{ dimension: LimitDimension; granted_limit: number }>(
      'SELECT dimension,granted_limit FROM task_limit_grants WHERE task_id=$1 ORDER BY created_at,id',
      [taskId],
    )
  ).rows;
  const effective = { ...snapshot };
  for (const grant of grants) {
    if (grant.dimension === 'durationMs') effective.durationMs = Number(grant.granted_limit);
    if (grant.dimension === 'turns') effective.turns = Number(grant.granted_limit);
    if (grant.dimension === 'depth') effective.depth = Number(grant.granted_limit);
    if (grant.dimension === 'handoffs') effective.handoffs = Number(grant.granted_limit);
  }
  return effective;
}

export async function loadLimitUsage(
  connection: SqlConnection,
  taskId: string,
  now: Date,
): Promise<LimitUsage> {
  const task = (
    await connection.query<{ depth: number }>('SELECT depth FROM tasks WHERE id=$1', [taskId])
  ).rows[0];
  const completed = (
    await connection.query<{ count: string | number }>(
      "SELECT COUNT(*)::int AS count FROM task_runs WHERE task_id=$1 AND status='completed'",
      [taskId],
    )
  ).rows[0];
  const running = (
    await connection.query<{ started_at: Date }>(
      "SELECT started_at FROM task_runs WHERE task_id=$1 AND status='running' ORDER BY attempt DESC LIMIT 1",
      [taskId],
    )
  ).rows[0];
  return {
    durationMs: running ? Math.max(0, now.getTime() - running.started_at.getTime()) : 0,
    turns: Number(completed?.count ?? 0),
    depth: Number(task?.depth ?? 0),
    handoffs: 0,
  };
}

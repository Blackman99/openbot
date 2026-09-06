import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { parseExecutionPolicy, type ExecutionLimitPolicy } from './execution-limits.js';

export const DEFAULT_GROUP_CONCURRENT_RUNS = 4;
export const CONCURRENCY_LAYERS = ['workspace', 'group', 'task'] as const;
export type ConcurrencyLayer = (typeof CONCURRENCY_LAYERS)[number];

export interface ResolvedConcurrencyLimits {
  workspace?: { maxConcurrentRuns: number; source: 'workspace' };
  group?: { maxConcurrentRuns: number; source: 'group' };
  task?: { maxConcurrentRuns: number; source: 'task' };
}

export interface ConcurrencyOccupancy {
  status: string;
  leaseExpiresAt?: Date | null;
}

export function resolveConcurrencyLimits(input: {
  workspace?: ExecutionLimitPolicy;
  group?: ExecutionLimitPolicy | null;
  task?: ExecutionLimitPolicy;
}): ResolvedConcurrencyLimits {
  const resolved: ResolvedConcurrencyLimits = {};
  if (input.workspace?.maxConcurrentRuns !== undefined)
    resolved.workspace = {
      maxConcurrentRuns: input.workspace.maxConcurrentRuns,
      source: 'workspace',
    };
  if (input.group !== undefined && input.group !== null)
    resolved.group = {
      maxConcurrentRuns: input.group.maxConcurrentRuns ?? DEFAULT_GROUP_CONCURRENT_RUNS,
      source: 'group',
    };
  if (input.task?.maxConcurrentRuns !== undefined)
    resolved.task = { maxConcurrentRuns: input.task.maxConcurrentRuns, source: 'task' };
  return resolved;
}

export function occupiesConcurrencySlot(run: ConcurrencyOccupancy, now: Date): boolean {
  if (run.status !== 'running') return false;
  return run.leaseExpiresAt == null || run.leaseExpiresAt.getTime() > now.getTime();
}

export function blockingConcurrencyLayer(
  limits: ResolvedConcurrencyLimits,
  used: { workspace: number; group: number; task: number },
): ConcurrencyLayer | undefined {
  for (const layer of ['task', 'group', 'workspace'] as const) {
    const cap = limits[layer]?.maxConcurrentRuns;
    if (cap !== undefined && used[layer] >= cap) return layer;
  }
}

export interface ConcurrencyHold {
  layer: ConcurrencyLayer;
  limit: number;
  used: number;
}

export interface ConcurrencyTarget {
  runId: string;
  taskId: string;
  workspaceId: string;
  groupId: string | null;
}

async function loadConcurrencyPolicies(
  connection: SqlConnection,
  target: ConcurrencyTarget,
): Promise<{
  workspace: ExecutionLimitPolicy;
  group: ExecutionLimitPolicy | null;
  task: ExecutionLimitPolicy;
}> {
  const workspace = (
    await connection.query<{ execution_policy: unknown }>(
      'SELECT execution_policy FROM workspaces WHERE id=$1',
      [target.workspaceId],
    )
  ).rows[0];
  const group = target.groupId
    ? (
        await connection.query<{ execution_policy: unknown; max_concurrent_runs: number | null }>(
          'SELECT execution_policy,max_concurrent_runs FROM groups WHERE id=$1 AND workspace_id=$2',
          [target.groupId, target.workspaceId],
        )
      ).rows[0]
    : undefined;
  const parent = (
    await connection.query<{ execution_policy: unknown }>(
      'SELECT execution_policy FROM tasks WHERE id=(SELECT parent_task_id FROM tasks WHERE id=$1)',
      [target.taskId],
    )
  ).rows[0];
  return {
    workspace: parseExecutionPolicy(workspace?.execution_policy),
    group: target.groupId
      ? {
          ...parseExecutionPolicy(group?.execution_policy ?? {}),
          ...(group?.max_concurrent_runs === null || group?.max_concurrent_runs === undefined
            ? {}
            : { maxConcurrentRuns: group.max_concurrent_runs }),
        }
      : null,
    task: parseExecutionPolicy(parent?.execution_policy ?? {}),
  };
}

async function countOccupiedSlots(
  connection: SqlConnection,
  target: ConcurrencyTarget,
  now: Date,
): Promise<{ workspace: number; group: number; task: number }> {
  const live = `r.status='running' AND (l.run_id IS NULL OR l.expires_at>$1)`;
  const workspace = (
    await connection.query<{ n: string | number }>(
      `SELECT count(*)::int AS n FROM task_runs r
       JOIN tasks t ON t.id=r.task_id
       LEFT JOIN task_run_leases l ON l.run_id=r.id
       WHERE ${live} AND t.workspace_id=$2`,
      [now, target.workspaceId],
    )
  ).rows[0];
  const group = target.groupId
    ? (
        await connection.query<{ n: string | number }>(
          `SELECT count(*)::int AS n FROM task_runs r
           JOIN tasks t ON t.id=r.task_id
           JOIN conversations c ON c.id=t.conversation_id
           LEFT JOIN task_run_leases l ON l.run_id=r.id
           WHERE ${live} AND c.group_id=$2`,
          [now, target.groupId],
        )
      ).rows[0]
    : { n: 0 };
  const task = (
    await connection.query<{ n: string | number }>(
      `SELECT count(*)::int AS n FROM task_runs r
       JOIN tasks child ON child.id=r.task_id
       JOIN tasks candidate ON candidate.id=$2
       JOIN tasks parent ON parent.id=candidate.parent_task_id
       LEFT JOIN task_run_leases l ON l.run_id=r.id
       WHERE ${live}
         AND child.root_task_id=parent.root_task_id
         AND child.depth>parent.depth`,
      [now, target.taskId],
    )
  ).rows[0];
  return {
    workspace: Number(workspace?.n ?? 0),
    group: Number(group?.n ?? 0),
    task: Number(task?.n ?? 0),
  };
}

export async function applyRunConcurrency(
  connection: SqlConnection,
  target: ConcurrencyTarget,
  now: Date,
): Promise<ConcurrencyHold | undefined> {
  const limits = resolveConcurrencyLimits(await loadConcurrencyPolicies(connection, target));
  const used = await countOccupiedSlots(connection, target, now);
  const layer = blockingConcurrencyLayer(limits, used);
  await connection.query('DELETE FROM task_run_concurrency_holds WHERE run_id=$1', [target.runId]);
  if (!layer) return undefined;
  const hold = { layer, limit: limits[layer]!.maxConcurrentRuns, used: used[layer] };
  await connection.query(
    `INSERT INTO task_run_concurrency_holds(run_id,task_id,layer,max_concurrent_runs,used,created_at)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [target.runId, target.taskId, hold.layer, hold.limit, hold.used, now],
  );
  return hold;
}

export async function clearRunConcurrencyHold(connection: SqlConnection, runId: string) {
  await connection.query('DELETE FROM task_run_concurrency_holds WHERE run_id=$1', [runId]);
}

export async function loadRunConcurrencyHolds(
  connection: SqlConnection,
  runIds: string[],
): Promise<Map<string, ConcurrencyHold>> {
  const holds = new Map<string, ConcurrencyHold>();
  for (const runId of runIds) {
    const row = (
      await connection.query<{
        run_id: string;
        layer: ConcurrencyLayer;
        max_concurrent_runs: string | number;
        used: string | number;
      }>(
        'SELECT run_id,layer,max_concurrent_runs,used FROM task_run_concurrency_holds WHERE run_id=$1',
        [runId],
      )
    ).rows[0];
    if (row)
      holds.set(row.run_id, {
        layer: row.layer,
        limit: Number(row.max_concurrent_runs),
        used: Number(row.used),
      });
  }
  return holds;
}

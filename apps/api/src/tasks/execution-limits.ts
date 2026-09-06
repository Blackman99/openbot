import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { BotLimits } from '../bots/service.js';
import { TaskInputError } from './errors.js';

// Duration is enforced later as active-Run milliseconds after lock wait.
// Turns count successful new Runs. Depth is parent edges from the root.
// Handoffs count committed Lead transfers. Workspace and Group policies are
// per-root templates, not shared daily quotas.

export const EXECUTION_LIMIT_LAYERS = ['workspace', 'group', 'task', 'run'] as const;
export type ExecutionLimitLayer = (typeof EXECUTION_LIMIT_LAYERS)[number];

export interface ExecutionLimitPolicy {
  maxDurationSeconds?: number;
  maxTurns?: number;
  maxDelegationDepth?: number;
  maxHandoffs?: number;
}

export interface ResolvedExecutionLimits {
  duration?: { maxDurationMs: number; source: ExecutionLimitLayer };
  turns?: { maxTurns: number; source: ExecutionLimitLayer };
  delegationDepth?: { maxDelegationDepth: number; source: ExecutionLimitLayer };
  handoffs?: { maxHandoffs: number; source: ExecutionLimitLayer };
}

const POLICY_KEYS = [
  'maxDurationSeconds',
  'maxTurns',
  'maxDelegationDepth',
  'maxHandoffs',
] as const;

const SPECIFICITY: readonly ExecutionLimitLayer[] = ['run', 'task', 'group', 'workspace'];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

export function parseExecutionPolicy(value: unknown): ExecutionLimitPolicy {
  if (value === undefined || value === null) return {};
  if (
    !object(value) ||
    Object.keys(value).some((key) => !POLICY_KEYS.includes(key as (typeof POLICY_KEYS)[number]))
  )
    throw new TaskInputError();
  const policy: ExecutionLimitPolicy = {};
  if ('maxDurationSeconds' in value) {
    if (!integer(value.maxDurationSeconds, 1)) throw new TaskInputError();
    policy.maxDurationSeconds = value.maxDurationSeconds;
  }
  if ('maxTurns' in value) {
    if (!integer(value.maxTurns, 1)) throw new TaskInputError();
    policy.maxTurns = value.maxTurns;
  }
  if ('maxDelegationDepth' in value) {
    if (!integer(value.maxDelegationDepth, 0)) throw new TaskInputError();
    policy.maxDelegationDepth = value.maxDelegationDepth;
  }
  if ('maxHandoffs' in value) {
    if (!integer(value.maxHandoffs, 0)) throw new TaskInputError();
    policy.maxHandoffs = value.maxHandoffs;
  }
  return policy;
}

export function taskPolicyFromBotLimits(limits: BotLimits): ExecutionLimitPolicy {
  return {
    maxDurationSeconds: limits.maxDurationSeconds,
    maxTurns: limits.maxTurns,
    maxDelegationDepth: limits.maxDelegationDepth,
  };
}

function pick<K extends keyof ExecutionLimitPolicy>(
  layers: Partial<Record<ExecutionLimitLayer, ExecutionLimitPolicy>>,
  key: K,
): { value: NonNullable<ExecutionLimitPolicy[K]>; source: ExecutionLimitLayer } | undefined {
  let selected:
    { value: NonNullable<ExecutionLimitPolicy[K]>; source: ExecutionLimitLayer } | undefined;
  for (const source of SPECIFICITY) {
    const value = layers[source]?.[key];
    if (value === undefined) continue;
    if (!selected || value < selected.value) selected = { value, source };
  }
  return selected;
}

export function resolveExecutionLimits(
  layers: Partial<Record<ExecutionLimitLayer, ExecutionLimitPolicy>>,
): ResolvedExecutionLimits {
  const duration = pick(layers, 'maxDurationSeconds');
  const turns = pick(layers, 'maxTurns');
  const delegationDepth = pick(layers, 'maxDelegationDepth');
  const handoffs = pick(layers, 'maxHandoffs');
  return {
    ...(duration
      ? { duration: { maxDurationMs: duration.value * 1000, source: duration.source } }
      : {}),
    ...(turns ? { turns: { maxTurns: turns.value, source: turns.source } } : {}),
    ...(delegationDepth
      ? {
          delegationDepth: {
            maxDelegationDepth: delegationDepth.value,
            source: delegationDepth.source,
          },
        }
      : {}),
    ...(handoffs ? { handoffs: { maxHandoffs: handoffs.value, source: handoffs.source } } : {}),
  };
}

export async function loadExecutionLimitPolicies(
  connection: SqlConnection,
  workspaceId: string,
  groupId: string | null,
): Promise<Pick<Record<ExecutionLimitLayer, ExecutionLimitPolicy>, 'workspace' | 'group'>> {
  const workspace = (
    await connection.query<{ execution_policy: unknown }>(
      'SELECT execution_policy FROM workspaces WHERE id=$1',
      [workspaceId],
    )
  ).rows[0];
  if (!workspace) throw new TaskInputError();
  if (!groupId) return { workspace: parseExecutionPolicy(workspace.execution_policy), group: {} };
  const group = (
    await connection.query<{ execution_policy: unknown }>(
      'SELECT execution_policy FROM groups WHERE workspace_id=$1 AND id=$2',
      [workspaceId, groupId],
    )
  ).rows[0];
  if (!group) throw new TaskInputError();
  return {
    workspace: parseExecutionPolicy(workspace.execution_policy),
    group: parseExecutionPolicy(group.execution_policy),
  };
}

export async function persistTaskLimitSnapshot(
  connection: SqlConnection,
  taskId: string,
  limits: ResolvedExecutionLimits,
  createdAt: Date,
): Promise<void> {
  if (!limits.duration || !limits.turns || !limits.delegationDepth) throw new TaskInputError();
  await connection.query(
    `INSERT INTO task_execution_limit_snapshots(
      task_id,max_duration_ms,duration_source,max_turns,turns_source,
      max_delegation_depth,delegation_depth_source,max_handoffs,handoffs_source,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      taskId,
      limits.duration.maxDurationMs,
      limits.duration.source,
      limits.turns.maxTurns,
      limits.turns.source,
      limits.delegationDepth.maxDelegationDepth,
      limits.delegationDepth.source,
      limits.handoffs?.maxHandoffs ?? null,
      limits.handoffs?.source ?? null,
      createdAt,
    ],
  );
}

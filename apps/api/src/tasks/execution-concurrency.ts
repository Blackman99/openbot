import type { ExecutionLimitPolicy } from './execution-limits.js';

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

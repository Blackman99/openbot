export const LIMIT_DIMENSIONS = ['durationMs', 'turns', 'depth', 'handoffs'] as const;
export type LimitDimension = (typeof LIMIT_DIMENSIONS)[number];
export type LimitSource = 'workspace' | 'group' | 'task' | 'run';

export interface LimitSnapshot {
  durationMs: number;
  durationSource: LimitSource;
  turns: number;
  turnsSource: LimitSource;
  depth: number;
  depthSource: LimitSource;
  handoffs: number;
  handoffsSource: LimitSource;
}

export interface LimitUsage {
  durationMs: number;
  turns: number;
  depth: number;
  handoffs: number;
}

export function softThreshold(hard: number): number {
  return Math.floor(hard * 0.8);
}

export function crossedSoftThreshold(usage: number, hard: number): boolean {
  const soft = softThreshold(hard);
  return soft > 0 && usage >= soft && usage < hard;
}

export function reachedHardLimit(usage: number, hard: number): boolean {
  return usage >= hard;
}

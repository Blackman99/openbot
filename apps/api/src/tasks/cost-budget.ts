import {
  EXECUTION_LIMIT_SOFT_DENOMINATOR,
  EXECUTION_LIMIT_SOFT_NUMERATOR,
} from './execution-limit-enforcement.js';
import type { ExecutionLimitLayer, ExecutionLimitPolicy } from './execution-limits.js';

export const COST_BUDGET_LAYERS = ['workspace', 'group', 'task'] as const;
export type CostBudgetLayer = (typeof COST_BUDGET_LAYERS)[number];

export type CostBudget = {
  maxCostMicros: number;
};

export type CostLedger = {
  usedMicros: number;
  reservedMicros: number;
};

function occupied(ledger: CostLedger, request = 0) {
  return ledger.usedMicros + ledger.reservedMicros + request;
}

function exceeds(limit: number | undefined, used: number) {
  return limit !== undefined && used > limit;
}

function crossedSoft(limit: number | undefined, used: number) {
  return (
    limit !== undefined &&
    limit > 0 &&
    used * EXECUTION_LIMIT_SOFT_DENOMINATOR >= limit * EXECUTION_LIMIT_SOFT_NUMERATOR
  );
}

export function evaluateCostReservation(input: {
  budget: CostBudget;
  usedMicros: number;
  reservedMicros: number;
  requestMicros: number;
}): {
  allowed: boolean;
  hard: boolean;
  soft: boolean;
  occupiedMicros: number;
  remainingMicros: number;
} {
  const next = occupied(
    { usedMicros: input.usedMicros, reservedMicros: input.reservedMicros },
    input.requestMicros,
  );
  const hard = exceeds(input.budget.maxCostMicros, next);
  return {
    allowed: !hard,
    hard,
    soft: crossedSoft(input.budget.maxCostMicros, next),
    occupiedMicros: next,
    remainingMicros: Math.max(0, input.budget.maxCostMicros - next),
  };
}

export function costBudgetFromPolicy(policy: ExecutionLimitPolicy): CostBudget | undefined {
  return policy.maxCostMicros !== undefined ? { maxCostMicros: policy.maxCostMicros } : undefined;
}

export function resolveCostBudgets(
  layers: Partial<Record<ExecutionLimitLayer, ExecutionLimitPolicy>>,
): Partial<Record<CostBudgetLayer, CostBudget>> {
  const budgets: Partial<Record<CostBudgetLayer, CostBudget>> = {};
  for (const kind of COST_BUDGET_LAYERS) {
    const policy = layers[kind];
    if (!policy) continue;
    const budget = costBudgetFromPolicy(policy);
    if (budget) budgets[kind] = budget;
  }
  return budgets;
}

export function tightestCostLimit(
  budgets: Partial<Record<CostBudgetLayer, CostBudget>>,
): number | undefined {
  const caps = COST_BUDGET_LAYERS.map((kind) => budgets[kind]?.maxCostMicros).filter(
    (value): value is number => value !== undefined,
  );
  return caps.length ? Math.min(...caps) : undefined;
}

export function overlayCostGrant(
  budgets: Partial<Record<CostBudgetLayer, CostBudget>>,
  grantedLimit?: number,
): Partial<Record<CostBudgetLayer, CostBudget>> {
  if (grantedLimit === undefined) return budgets;
  const overlay: Partial<Record<CostBudgetLayer, CostBudget>> = {};
  for (const kind of COST_BUDGET_LAYERS) {
    const current = budgets[kind];
    if (current) overlay[kind] = { maxCostMicros: Math.max(current.maxCostMicros, grantedLimit) };
  }
  overlay.task = { maxCostMicros: Math.max(overlay.task?.maxCostMicros ?? 0, grantedLimit) };
  return overlay;
}

export type CostReservationDecision = ReturnType<typeof evaluateCostReservation>;

export function evaluateScopedCostReservation(input: {
  requestMicros: number;
  scopes: Array<{
    kind: CostBudgetLayer;
    budget: CostBudget;
    usedMicros: number;
    reservedMicros: number;
  }>;
}): {
  allowed: boolean;
  hard: boolean;
  soft: boolean;
  blocked?: { kind: CostBudgetLayer } & CostReservationDecision;
  warnings: Array<{ kind: CostBudgetLayer } & CostReservationDecision>;
} {
  const warnings: Array<{ kind: CostBudgetLayer } & CostReservationDecision> = [];
  for (const scope of input.scopes) {
    const decision = evaluateCostReservation({
      budget: scope.budget,
      usedMicros: scope.usedMicros,
      reservedMicros: scope.reservedMicros,
      requestMicros: input.requestMicros,
    });
    if (decision.hard)
      return {
        allowed: false,
        hard: true,
        soft: decision.soft,
        blocked: { kind: scope.kind, ...decision },
        warnings,
      };
    if (decision.soft) warnings.push({ kind: scope.kind, ...decision });
  }
  return { allowed: true, hard: false, soft: warnings.length > 0, warnings };
}

export type CostBudgetScopeView = {
  kind: CostBudgetLayer;
  usedMicros: number;
  reservedMicros: number;
  remainingMicros: number;
};

export function projectCostBudgetScope(
  kind: CostBudgetLayer,
  budget: CostBudget,
  ledger: CostLedger,
): CostBudgetScopeView {
  const taken = occupied(ledger);
  return {
    kind,
    usedMicros: ledger.usedMicros,
    reservedMicros: ledger.reservedMicros,
    remainingMicros: Math.max(0, budget.maxCostMicros - taken),
  };
}

export type CostBudgetWarningCrossing = {
  dimension: 'cost';
  used: number;
  limit: number;
  source: CostBudgetLayer;
  soft: true;
  hard: boolean;
};

export function costBudgetWarningCrossings(
  warnings: Array<{ kind: CostBudgetLayer } & CostReservationDecision>,
): CostBudgetWarningCrossing[] {
  return warnings
    .filter((warning) =>
      crossedSoft(warning.occupiedMicros + warning.remainingMicros, warning.occupiedMicros),
    )
    .map((warning) => ({
      dimension: 'cost' as const,
      used: warning.occupiedMicros,
      limit: warning.occupiedMicros + warning.remainingMicros,
      source: warning.kind,
      soft: true,
      hard: warning.hard,
    }));
}

import {
  EXECUTION_LIMIT_SOFT_DENOMINATOR,
  EXECUTION_LIMIT_SOFT_NUMERATOR,
} from './execution-limit-enforcement.js';
import type { ExecutionLimitLayer, ExecutionLimitPolicy } from './execution-limits.js';

export const TOKEN_BUDGET_LAYERS = ['workspace', 'group', 'task', 'run'] as const;
export type TokenBudgetLayer = (typeof TOKEN_BUDGET_LAYERS)[number];

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
};

export type TokenBudget = {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
};

export type TokenLedger = {
  used: TokenCounts;
  reserved: TokenCounts;
};

function total(counts: TokenCounts) {
  return counts.inputTokens + counts.outputTokens;
}

function add(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function occupied(ledger: TokenLedger, request?: TokenCounts) {
  const counts = request
    ? add(add(ledger.used, ledger.reserved), request)
    : add(ledger.used, ledger.reserved);
  return { ...counts, totalTokens: total(counts) };
}

function remaining(
  budget: TokenBudget,
  taken: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  return {
    inputTokens: Math.max(
      0,
      (budget.maxInputTokens ?? Number.POSITIVE_INFINITY) - taken.inputTokens,
    ),
    outputTokens: Math.max(
      0,
      (budget.maxOutputTokens ?? Number.POSITIVE_INFINITY) - taken.outputTokens,
    ),
    totalTokens: Math.max(
      0,
      (budget.maxTotalTokens ?? Number.POSITIVE_INFINITY) - taken.totalTokens,
    ),
  };
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

export function evaluateTokenReservation(input: {
  budget: TokenBudget;
  used: TokenCounts;
  reserved: TokenCounts;
  request: TokenCounts;
}): {
  allowed: boolean;
  hard: boolean;
  soft: boolean;
  occupied: TokenCounts & { totalTokens: number };
  remaining: { inputTokens: number; outputTokens: number; totalTokens: number };
} {
  const next = occupied({ used: input.used, reserved: input.reserved }, input.request);
  const hard =
    exceeds(input.budget.maxInputTokens, next.inputTokens) ||
    exceeds(input.budget.maxOutputTokens, next.outputTokens) ||
    exceeds(input.budget.maxTotalTokens, next.totalTokens);
  const soft =
    crossedSoft(input.budget.maxInputTokens, next.inputTokens) ||
    crossedSoft(input.budget.maxOutputTokens, next.outputTokens) ||
    crossedSoft(input.budget.maxTotalTokens, next.totalTokens);
  return {
    allowed: !hard,
    hard,
    soft,
    occupied: next,
    remaining: remaining(input.budget, next),
  };
}

export function reservationRequestForRun(
  maxTotalTokens: number,
  estimatedInputTokens: number,
): TokenCounts {
  const inputTokens = Math.min(maxTotalTokens, Math.max(0, estimatedInputTokens));
  return {
    inputTokens,
    outputTokens: Math.max(0, maxTotalTokens - inputTokens),
  };
}

export function reconcileTokenReservation(ledger: TokenLedger, usage: TokenCounts): TokenLedger {
  return {
    reserved: { inputTokens: 0, outputTokens: 0 },
    used: add(ledger.used, usage),
  };
}

export function tokenBudgetFromPolicy(policy: ExecutionLimitPolicy): TokenBudget {
  return {
    ...(policy.maxInputTokens !== undefined ? { maxInputTokens: policy.maxInputTokens } : {}),
    ...(policy.maxOutputTokens !== undefined ? { maxOutputTokens: policy.maxOutputTokens } : {}),
    ...(policy.maxTotalTokens !== undefined ? { maxTotalTokens: policy.maxTotalTokens } : {}),
  };
}

export const TOKEN_BUDGET_WARNING_DIMENSIONS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
] as const;
export type TokenBudgetWarningDimension = (typeof TOKEN_BUDGET_WARNING_DIMENSIONS)[number];

export type TokenBudgetWarningCrossing = {
  dimension: TokenBudgetWarningDimension;
  used: number;
  limit: number;
  source: Exclude<TokenBudgetLayer, 'run'>;
  soft: true;
  hard: boolean;
};

export function tokenBudgetWarningCrossings(
  warnings: Array<{ kind: TokenBudgetLayer } & TokenReservationDecision>,
): TokenBudgetWarningCrossing[] {
  const crossings: TokenBudgetWarningCrossing[] = [];
  for (const warning of warnings) {
    if (warning.kind === 'run') continue;
    const source = warning.kind;
    const add = (dimension: TokenBudgetWarningDimension, used: number, remainingTokens: number) => {
      if (!Number.isFinite(remainingTokens)) return;
      const limit = used + remainingTokens;
      if (!crossedSoft(limit, used)) return;
      crossings.push({ dimension, used, limit, source, soft: true, hard: warning.hard });
    };
    add('inputTokens', warning.occupied.inputTokens, warning.remaining.inputTokens);
    add('outputTokens', warning.occupied.outputTokens, warning.remaining.outputTokens);
    add('totalTokens', warning.occupied.totalTokens, warning.remaining.totalTokens);
  }
  return crossings;
}

export type TokenReservationDecision = ReturnType<typeof evaluateTokenReservation>;

export function evaluateScopedTokenReservation(input: {
  request: TokenCounts;
  scopes: Array<{
    kind: TokenBudgetLayer;
    budget: TokenBudget;
    used: TokenCounts;
    reserved: TokenCounts;
  }>;
}): {
  allowed: boolean;
  hard: boolean;
  soft: boolean;
  blocked?: { kind: TokenBudgetLayer } & TokenReservationDecision;
  warnings: Array<{ kind: TokenBudgetLayer } & TokenReservationDecision>;
} {
  const warnings: Array<{ kind: TokenBudgetLayer } & TokenReservationDecision> = [];
  for (const scope of input.scopes) {
    const decision = evaluateTokenReservation({
      budget: scope.budget,
      used: scope.used,
      reserved: scope.reserved,
      request: input.request,
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

export type TokenBudgetCounts = TokenCounts & { totalTokens: number };

export type TokenBudgetRemaining = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type TokenBudgetScopeView = {
  kind: TokenBudgetLayer;
  used: TokenBudgetCounts;
  reserved: TokenBudgetCounts;
  remaining: TokenBudgetRemaining;
};

export function projectTokenBudgetScope(
  kind: TokenBudgetLayer,
  budget: TokenBudget,
  ledger: TokenLedger,
): TokenBudgetScopeView {
  const taken = occupied(ledger);
  const left = remaining(budget, taken);
  return {
    kind,
    used: { ...ledger.used, totalTokens: total(ledger.used) },
    reserved: { ...ledger.reserved, totalTokens: total(ledger.reserved) },
    remaining: {
      ...(budget.maxInputTokens !== undefined ? { inputTokens: left.inputTokens } : {}),
      ...(budget.maxOutputTokens !== undefined ? { outputTokens: left.outputTokens } : {}),
      ...(budget.maxTotalTokens !== undefined ? { totalTokens: left.totalTokens } : {}),
    },
  };
}

export function resolveTokenBudgets(
  layers: Partial<Record<ExecutionLimitLayer, ExecutionLimitPolicy>>,
): Partial<Record<TokenBudgetLayer, TokenBudget>> {
  const budgets: Partial<Record<TokenBudgetLayer, TokenBudget>> = {};
  for (const kind of TOKEN_BUDGET_LAYERS) {
    const policy = layers[kind];
    if (!policy) continue;
    const budget = tokenBudgetFromPolicy(policy);
    if (
      budget.maxInputTokens !== undefined ||
      budget.maxOutputTokens !== undefined ||
      budget.maxTotalTokens !== undefined
    )
      budgets[kind] = budget;
  }
  return budgets;
}

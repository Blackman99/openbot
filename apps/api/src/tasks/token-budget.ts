import {
  EXECUTION_LIMIT_SOFT_DENOMINATOR,
  EXECUTION_LIMIT_SOFT_NUMERATOR,
} from './execution-limit-enforcement.js';

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

export function reconcileTokenReservation(ledger: TokenLedger, usage: TokenCounts): TokenLedger {
  return {
    reserved: { inputTokens: 0, outputTokens: 0 },
    used: add(ledger.used, usage),
  };
}

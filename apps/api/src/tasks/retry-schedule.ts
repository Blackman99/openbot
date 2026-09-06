import type { BotBinding, BotConfiguration, BotRetryPolicy } from '../bots/service.js';
import type { ModelFailure } from '../providers/model-events.js';
import { isAutomaticRetryFailure } from '../providers/failure-taxonomy.js';

export const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 1;
export const DEFAULT_MAX_RUNS_PER_CHAIN = 4;
export const HARD_MAX_RUNS_PER_CHAIN = 4;
export const MAX_JITTER_MS = 250;
export const SAME_MODEL_RETRY_DELAYS_MS = [1_000, 2_000] as const;
export const FALLBACK_DELAY_MS = 1_000;
export const COL10_RETRY_DELAY_ENV = 'OPENBOT_COL10_RETRY_DELAY_MS';

export function composeRetryDelayMs(
  environment: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = environment[COL10_RETRY_DELAY_ENV];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < SAME_MODEL_RETRY_DELAYS_MS[0]) return undefined;
  return value;
}

export type AttemptOrigin =
  | 'initial'
  | 'manual_retry'
  | 'provider_retry'
  | 'model_fallback'
  | 'worker_recovery'
  | 'manual_resume';

export interface EffectiveRetryPolicy {
  maxAttemptsPerModel: number;
  maxRunsPerChain: number;
}

export interface ChainAttempt {
  runId: string;
  connectionId: string;
  modelId: string;
  origin: AttemptOrigin;
}

export interface NextAttemptPlan {
  origin: 'provider_retry' | 'model_fallback' | 'manual_resume' | 'worker_recovery';
  reason: string;
  binding: BotBinding;
  previousBinding: BotBinding;
  notBefore: Date;
  delayMs: number;
  jitterMs: number;
  chainRootRunId: string;
  previousRunId: string;
  chainAttemptOrdinal: number;
  chainLimitSnapshot: number;
  modelAttemptOrdinal: number;
}

export function effectiveRetryPolicy(policy?: BotRetryPolicy): EffectiveRetryPolicy {
  return {
    maxAttemptsPerModel: policy?.maxAttemptsPerModel ?? DEFAULT_MAX_ATTEMPTS_PER_MODEL,
    maxRunsPerChain: Math.min(
      policy?.maxRunsPerChain ?? DEFAULT_MAX_RUNS_PER_CHAIN,
      HARD_MAX_RUNS_PER_CHAIN,
    ),
  };
}

export function chooseRetryJitterMs(random = Math.random): number {
  return Math.floor(random() * (MAX_JITTER_MS + 1));
}

export function versionListsBinding(configuration: BotConfiguration, binding: BotBinding): boolean {
  return listedBindings(configuration).some((item) => sameBinding(item, binding));
}

export function planNextAttempt(input: {
  failure?: ModelFailure;
  configuration: Pick<BotConfiguration, 'modelBinding' | 'retryPolicy' | 'fallbackBindings'>;
  chain: {
    rootRunId: string;
    previousRunId: string;
    attempts: ChainAttempt[];
  };
  now: Date;
  jitterMs?: number;
}): NextAttemptPlan | undefined {
  if (!isAutomaticRetryFailure(input.failure)) return undefined;
  const policy = effectiveRetryPolicy(input.configuration.retryPolicy);
  const attempts = input.chain.attempts;
  if (!attempts.length || attempts.length >= policy.maxRunsPerChain) return undefined;
  const current = attempts.at(-1)!;
  if (current.runId !== input.chain.previousRunId) return undefined;
  const listed = listedBindings(input.configuration);
  const currentIndex = listed.findIndex((binding) => sameModel(current, binding));
  const currentBinding =
    currentIndex >= 0
      ? listed[currentIndex]!
      : {
          scope: input.configuration.modelBinding.scope,
          connectionId: current.connectionId,
          modelId: current.modelId,
        };
  const jitterMs = boundedJitter(input.jitterMs);
  const usedCurrent = attempts.filter((attempt) => sameModel(attempt, currentBinding)).length;
  let origin: NextAttemptPlan['origin'];
  let binding: BotBinding;
  let delayMs: number;
  let modelAttemptOrdinal: number;
  if (currentIndex >= 0 && usedCurrent < policy.maxAttemptsPerModel) {
    origin = 'provider_retry';
    binding = currentBinding;
    delayMs =
      composeRetryDelayMs() ??
      SAME_MODEL_RETRY_DELAYS_MS[
        Math.min(Math.max(usedCurrent - 1, 0), SAME_MODEL_RETRY_DELAYS_MS.length - 1)
      ]!;
    modelAttemptOrdinal = usedCurrent + 1;
  } else {
    const start = currentIndex >= 0 ? currentIndex + 1 : listed.length;
    let selected: BotBinding | undefined;
    let selectedUsed = 0;
    for (let index = start; index < listed.length; index++) {
      const candidate = listed[index]!;
      const used = attempts.filter((attempt) => sameModel(attempt, candidate)).length;
      if (used < policy.maxAttemptsPerModel) {
        selected = candidate;
        selectedUsed = used;
        break;
      }
    }
    if (!selected) return undefined;
    origin = 'model_fallback';
    binding = selected;
    delayMs = composeRetryDelayMs() ?? FALLBACK_DELAY_MS;
    modelAttemptOrdinal = selectedUsed + 1;
  }
  return {
    origin,
    reason: input.failure!.code,
    binding,
    previousBinding: currentBinding,
    notBefore: new Date(input.now.getTime() + delayMs + jitterMs),
    delayMs,
    jitterMs,
    chainRootRunId: input.chain.rootRunId,
    previousRunId: input.chain.previousRunId,
    chainAttemptOrdinal: attempts.length + 1,
    chainLimitSnapshot: policy.maxRunsPerChain,
    modelAttemptOrdinal,
  };
}

function listedBindings(
  configuration: Pick<BotConfiguration, 'modelBinding' | 'fallbackBindings'>,
): BotBinding[] {
  return [configuration.modelBinding, ...(configuration.fallbackBindings ?? [])];
}

function sameBinding(left: BotBinding, right: BotBinding): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.modelId === right.modelId &&
    left.scope.kind === right.scope.kind &&
    left.scope.id === right.scope.id
  );
}

function sameModel(
  attempt: { connectionId: string; modelId: string },
  binding: Pick<BotBinding, 'connectionId' | 'modelId'>,
): boolean {
  return attempt.connectionId === binding.connectionId && attempt.modelId === binding.modelId;
}

function boundedJitter(value?: number): number {
  if (Number.isInteger(value) && value! >= 0 && value! <= MAX_JITTER_MS) return value!;
  return chooseRetryJitterMs();
}

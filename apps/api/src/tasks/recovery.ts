import type { BotBinding } from '../bots/service.js';
import type { NextAttemptPlan } from './retry-schedule.js';

export function planWorkerRecovery(input: {
  binding: BotBinding;
  sourceRunId: string;
  chainRootRunId: string;
  chainAttemptOrdinal: number;
  chainLimitSnapshot: number;
  now: Date;
}): NextAttemptPlan {
  return {
    origin: 'worker_recovery',
    reason: 'worker_interrupted',
    binding: input.binding,
    previousBinding: input.binding,
    notBefore: input.now,
    delayMs: 0,
    jitterMs: 0,
    chainRootRunId: input.chainRootRunId,
    previousRunId: input.sourceRunId,
    chainAttemptOrdinal: input.chainAttemptOrdinal,
    chainLimitSnapshot: input.chainLimitSnapshot,
    modelAttemptOrdinal: 1,
  };
}

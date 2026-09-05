import { describe, expect, it } from 'vitest';
import { modelFailure } from '../../src/providers/failure-taxonomy.js';
import {
  COL10_RETRY_DELAY_ENV,
  composeRetryDelayMs,
  DEFAULT_MAX_ATTEMPTS_PER_MODEL,
  DEFAULT_MAX_RUNS_PER_CHAIN,
  effectiveRetryPolicy,
  FALLBACK_DELAY_MS,
  HARD_MAX_RUNS_PER_CHAIN,
  MAX_JITTER_MS,
  planNextAttempt,
  SAME_MODEL_RETRY_DELAYS_MS,
  type ChainAttempt,
} from '../../src/tasks/retry-schedule.js';

const owner = '11111111-1111-4111-8111-111111111111';
const primaryId = '33333333-3333-4333-8333-333333333333';
const fallbackId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const now = new Date('2026-09-05T12:00:00.000Z');

const primary = {
  scope: { kind: 'personal' as const, id: owner },
  connectionId: primaryId,
  modelId: 'primary-model',
};
const fallback = {
  scope: { kind: 'personal' as const, id: owner },
  connectionId: fallbackId,
  modelId: 'fallback-model',
};
const unlisted = {
  scope: { kind: 'personal' as const, id: owner },
  connectionId: otherId,
  modelId: 'other-model',
};

function attempt(
  runId: string,
  binding = primary,
  origin: ChainAttempt['origin'] = 'initial',
): ChainAttempt {
  return {
    runId,
    connectionId: binding.connectionId,
    modelId: binding.modelId,
    origin,
  };
}

function plan(
  overrides: Partial<Parameters<typeof planNextAttempt>[0]> & {
    failure?: Parameters<typeof planNextAttempt>[0]['failure'];
  } = {},
) {
  return planNextAttempt({
    failure: modelFailure('provider_rate_limited'),
    configuration: {
      modelBinding: primary,
      retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
      fallbackBindings: [fallback],
    },
    chain: {
      rootRunId: 'run-1',
      previousRunId: 'run-1',
      attempts: [attempt('run-1')],
    },
    now,
    jitterMs: 0,
    ...overrides,
  });
}

describe('COL-10 bounded retry scheduler', () => {
  it('treats an absent legacy policy as one attempt per model, no fallback, and a shared chain ceiling of four', () => {
    expect(effectiveRetryPolicy(undefined)).toEqual({
      maxAttemptsPerModel: DEFAULT_MAX_ATTEMPTS_PER_MODEL,
      maxRunsPerChain: DEFAULT_MAX_RUNS_PER_CHAIN,
    });
    expect(DEFAULT_MAX_ATTEMPTS_PER_MODEL).toBe(1);
    expect(DEFAULT_MAX_RUNS_PER_CHAIN).toBe(4);
    expect(HARD_MAX_RUNS_PER_CHAIN).toBe(4);
    expect(
      plan({
        configuration: { modelBinding: primary },
        failure: { code: 'provider_failed', category: 'retryable' },
      }),
    ).toBeUndefined();
  });

  it.each([
    'provider_authentication_failed',
    'provider_request_failed',
    'provider_timeout',
    'provider_tls_failed',
    'provider_interrupted_stream',
    'provider_unreachable',
    'unknown_structured_error',
  ] as const)('does not retry or fall back for terminal %s', (code) => {
    expect(plan({ failure: modelFailure(code) })).toBeUndefined();
  });

  it.each(['provider_rate_limited', 'provider_unavailable', 'provider_connection_reset'] as const)(
    'schedules one same-model retry for %s before the per-model cap',
    (code) => {
      const next = plan({ failure: modelFailure(code) });
      expect(next).toMatchObject({
        origin: 'provider_retry',
        reason: code,
        binding: primary,
        previousBinding: primary,
        delayMs: SAME_MODEL_RETRY_DELAYS_MS[0],
        jitterMs: 0,
        chainRootRunId: 'run-1',
        previousRunId: 'run-1',
        chainAttemptOrdinal: 2,
        chainLimitSnapshot: 4,
        modelAttemptOrdinal: 2,
      });
      expect(next?.notBefore).toEqual(new Date(now.getTime() + SAME_MODEL_RETRY_DELAYS_MS[0]));
    },
  );

  it('uses the second same-model backoff and then only a configured fallback', () => {
    const second = plan({
      chain: {
        rootRunId: 'run-1',
        previousRunId: 'run-2',
        attempts: [attempt('run-1'), attempt('run-2', primary, 'provider_retry')],
      },
    });
    expect(second).toMatchObject({
      origin: 'provider_retry',
      binding: primary,
      delayMs: SAME_MODEL_RETRY_DELAYS_MS[1],
      chainAttemptOrdinal: 3,
      modelAttemptOrdinal: 3,
    });
    const afterCap = plan({
      configuration: {
        modelBinding: primary,
        retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
        fallbackBindings: [fallback],
      },
      chain: {
        rootRunId: 'run-1',
        previousRunId: 'run-2',
        attempts: [attempt('run-1'), attempt('run-2', primary, 'provider_retry')],
      },
    });
    expect(afterCap).toMatchObject({
      origin: 'model_fallback',
      reason: 'provider_rate_limited',
      binding: fallback,
      previousBinding: primary,
      delayMs: FALLBACK_DELAY_MS,
      chainAttemptOrdinal: 3,
      modelAttemptOrdinal: 1,
    });
    expect(afterCap?.notBefore).toEqual(new Date(now.getTime() + FALLBACK_DELAY_MS));
  });

  it('never selects an unlisted, exhausted, or earlier model and stops at the chain ceiling', () => {
    expect(
      plan({
        configuration: {
          modelBinding: primary,
          retryPolicy: { maxAttemptsPerModel: 1, maxRunsPerChain: 4 },
        },
      }),
    ).toBeUndefined();
    expect(
      plan({
        configuration: {
          modelBinding: primary,
          retryPolicy: { maxAttemptsPerModel: 1, maxRunsPerChain: 4 },
          fallbackBindings: [unlisted],
        },
        chain: {
          rootRunId: 'run-1',
          previousRunId: 'run-1',
          attempts: [attempt('run-1', fallback)],
        },
      }),
    ).toBeUndefined();
    expect(
      plan({
        chain: {
          rootRunId: 'run-1',
          previousRunId: 'run-4',
          attempts: [
            attempt('run-1'),
            attempt('run-2', primary, 'provider_retry'),
            attempt('run-3', primary, 'worker_recovery'),
            attempt('run-4', fallback, 'model_fallback'),
          ],
        },
      }),
    ).toBeUndefined();
  });

  it('persists jitter once and counts recovery toward the shared chain budget', () => {
    const first = plan({ jitterMs: 250 });
    expect(first?.jitterMs).toBe(250);
    expect(first?.notBefore).toEqual(
      new Date(now.getTime() + SAME_MODEL_RETRY_DELAYS_MS[0] + MAX_JITTER_MS),
    );
    expect(plan({ jitterMs: 250 })).toEqual(first);
    const afterRecovery = plan({
      configuration: {
        modelBinding: primary,
        retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
        fallbackBindings: [fallback],
      },
      chain: {
        rootRunId: 'run-1',
        previousRunId: 'run-3',
        attempts: [
          attempt('run-1'),
          attempt('run-2', primary, 'provider_retry'),
          attempt('run-3', primary, 'worker_recovery'),
        ],
      },
    });
    expect(afterRecovery).toMatchObject({
      origin: 'model_fallback',
      binding: fallback,
      chainAttemptOrdinal: 4,
    });
  });

  it('lets Compose lengthen notBefore without shortening the production delays', () => {
    const previous = process.env[COL10_RETRY_DELAY_ENV];
    try {
      expect(composeRetryDelayMs({})).toBeUndefined();
      expect(composeRetryDelayMs({ [COL10_RETRY_DELAY_ENV]: '500' })).toBeUndefined();
      expect(composeRetryDelayMs({ [COL10_RETRY_DELAY_ENV]: '60000' })).toBe(60_000);
      process.env[COL10_RETRY_DELAY_ENV] = '60000';
      expect(plan({ jitterMs: 0 })?.delayMs).toBe(60_000);
      expect(
        plan({
          configuration: {
            modelBinding: primary,
            retryPolicy: { maxAttemptsPerModel: 1, maxRunsPerChain: 4 },
            fallbackBindings: [fallback],
          },
          jitterMs: 0,
        })?.delayMs,
      ).toBe(60_000);
    } finally {
      if (previous === undefined) delete process.env[COL10_RETRY_DELAY_ENV];
      else process.env[COL10_RETRY_DELAY_ENV] = previous;
    }
    expect(plan({ jitterMs: 0 })?.delayMs).toBe(SAME_MODEL_RETRY_DELAYS_MS[0]);
  });
});

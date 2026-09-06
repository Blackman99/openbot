import { describe, expect, it } from 'vitest';
import { BotInputError, parseBotConfiguration } from '../../src/bots/service.js';
import { applyConfigurationChange, compareConfigurations } from '../../src/bots/version-data.js';
import { botConfigurationView } from '../../src/bots/configuration-view.js';
import { copyBotConfiguration } from '../../src/bots/copy-service.js';

const owner = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const primary = '33333333-3333-4333-8333-333333333333';
const fallback = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';

const base = {
  name: 'Research helper',
  roleDescription: 'Evidence reviewer',
  description: 'Checks sources',
  instructions: 'Cite uncertainty.\n',
  modelBinding: {
    scope: { kind: 'personal' as const, id: owner },
    connectionId: primary,
    modelId: 'primary-model',
  },
  limits: {
    maxTotalTokens: 32768,
    maxDurationSeconds: 300,
    maxTurns: 8,
    maxDelegationDepth: 2,
  },
};

describe('COL-10 Bot retry and fallback configuration', () => {
  it('keeps historical configurations unchanged when retry fields are absent', () => {
    const parsed = parseBotConfiguration(base);
    expect(parsed.retryPolicy).toBeUndefined();
    expect(parsed.fallbackBindings).toBeUndefined();
    expect(botConfigurationView(parsed)).toEqual(parsed);
    expect(applyConfigurationChange(parsed, { name: 'Renamed' }).retryPolicy).toBeUndefined();
  });

  it('persists an explicit retry policy and ordered fallbacks that stay in the primary scope', () => {
    const parsed = parseBotConfiguration({
      ...base,
      retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
      fallbackBindings: [
        {
          scope: { kind: 'personal', id: owner.toUpperCase() },
          connectionId: fallback.toUpperCase(),
          modelId: 'fallback-one',
        },
        {
          scope: { kind: 'personal', id: owner },
          connectionId: other,
          modelId: 'fallback-two',
        },
      ],
    });
    expect(parsed.retryPolicy).toEqual({ maxAttemptsPerModel: 3, maxRunsPerChain: 4 });
    expect(parsed.fallbackBindings).toEqual([
      {
        scope: { kind: 'personal', id: owner },
        connectionId: fallback,
        modelId: 'fallback-one',
      },
      {
        scope: { kind: 'personal', id: owner },
        connectionId: other,
        modelId: 'fallback-two',
      },
    ]);
    expect(botConfigurationView(parsed).retryPolicy).toEqual(parsed.retryPolicy);
    expect(botConfigurationView(parsed).fallbackBindings).toEqual(parsed.fallbackBindings);
  });

  it('rejects unknown fields, incomplete policies, primary duplicates and cross-scope fallbacks', () => {
    const fallbacks = [
      {
        scope: { kind: 'personal' as const, id: owner },
        connectionId: fallback,
        modelId: 'fallback-one',
      },
    ];
    for (const input of [
      { ...base, retryAfterSeconds: 1 },
      { ...base, retryPolicy: { maxAttemptsPerModel: 2 } },
      { ...base, retryPolicy: { maxAttemptsPerModel: 0, maxRunsPerChain: 4 } },
      { ...base, retryPolicy: { maxAttemptsPerModel: 4, maxRunsPerChain: 4 } },
      { ...base, retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 5 } },
      { ...base, fallbackBindings: fallbacks },
      {
        ...base,
        retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
        fallbackBindings: [
          {
            scope: { kind: 'personal', id: owner },
            connectionId: primary,
            modelId: 'other-model',
          },
        ],
      },
      {
        ...base,
        retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
        fallbackBindings: [
          ...fallbacks,
          {
            scope: { kind: 'personal', id: owner },
            connectionId: fallback,
            modelId: 'duplicate-connection',
          },
        ],
      },
      {
        ...base,
        retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
        fallbackBindings: [
          {
            scope: { kind: 'workspace', id: workspace },
            connectionId: fallback,
            modelId: 'workspace-model',
          },
        ],
      },
      {
        ...base,
        retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
        fallbackBindings: [
          fallbacks[0],
          {
            scope: { kind: 'personal', id: owner },
            connectionId: other,
            modelId: 'two',
          },
          {
            scope: { kind: 'personal', id: owner },
            connectionId: '66666666-6666-4666-8666-666666666666',
            modelId: 'three',
          },
          {
            scope: { kind: 'personal', id: owner },
            connectionId: '77777777-7777-4777-8777-777777777777',
            modelId: 'four',
          },
        ],
      },
    ]) {
      expect(() => parseBotConfiguration(input)).toThrow(BotInputError);
    }
  });

  it('compares retry and fallback fields without leaking credentials', () => {
    const before = parseBotConfiguration(base);
    const after = parseBotConfiguration({
      ...base,
      retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 3 },
      fallbackBindings: [
        {
          scope: { kind: 'personal', id: owner },
          connectionId: fallback,
          modelId: 'fallback-one',
        },
      ],
    });
    expect(compareConfigurations(before, after)).toEqual([
      { field: 'retryPolicy.maxAttemptsPerModel', before: null, after: 2 },
      { field: 'retryPolicy.maxRunsPerChain', before: null, after: 3 },
      {
        field: 'fallbackBindings',
        before: null,
        after: `${fallback}:fallback-one`,
      },
    ]);
  });

  it('copies compatible fallbacks and drops them when a rebound primary makes them foreign', () => {
    const source = parseBotConfiguration({
      ...base,
      retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
      fallbackBindings: [
        {
          scope: { kind: 'personal', id: owner },
          connectionId: fallback,
          modelId: 'fallback-one',
        },
      ],
    });
    const samePrimary = copyBotConfiguration(source);
    expect(samePrimary.retryPolicy).toEqual(source.retryPolicy);
    expect(samePrimary.fallbackBindings).toEqual(source.fallbackBindings);
    const rebound = copyBotConfiguration(source, {
      scope: { kind: 'workspace', id: workspace },
      connectionId: other,
      modelId: 'workspace-model',
    });
    expect(rebound.retryPolicy).toEqual(source.retryPolicy);
    expect(rebound.fallbackBindings).toBeUndefined();
    expect(rebound.modelBinding.connectionId).toBe(other);
  });
});

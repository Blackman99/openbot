import { describe, expect, it } from 'vitest';
import { parseBotConfiguration } from '../../src/lib/server/bot-api.js';
import { parseBotVersionChanges, versionFields } from '../../src/lib/server/bot-version-api.js';
import { input, workspace } from '../fixtures/bots.js';

const fallback = '44444444-4444-4444-8444-444444444444';

describe('COL-10 strict Bot retry configuration DTO', () => {
  it('accepts optional reviewed retry fields and rejects unknown keys', () => {
    expect(parseBotConfiguration(input, workspace.id)).toEqual(input);
    const withPolicy = {
      ...input,
      retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
      fallbackBindings: [
        {
          scope: { kind: 'workspace' as const, id: workspace.id },
          connectionId: fallback,
          modelId: 'fallback-model',
        },
      ],
    };
    expect(parseBotConfiguration(withPolicy, workspace.id)).toEqual(withPolicy);
    expect(parseBotConfiguration({ ...input, retryAfterSeconds: 1 }, workspace.id)).toBeUndefined();
    expect(
      parseBotVersionChanges(
        { retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 3 } },
        workspace.id,
      ),
    ).toEqual({ retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 3 } });
    expect(versionFields).toEqual(
      expect.arrayContaining([
        'retryPolicy.maxAttemptsPerModel',
        'retryPolicy.maxRunsPerChain',
        'fallbackBindings',
      ]),
    );
  });
});

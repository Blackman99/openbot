import { describe, expect, it } from 'vitest';
import { TaskInputError } from '../../src/tasks/errors.js';
import { costMicros, parseModelPriceInput } from '../../src/tasks/model-price.js';

const connectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('COL-18 model price versions', () => {
  it('accepts integer micros-per-million rates and prices tokens with ceiling', () => {
    expect(
      parseModelPriceInput({
        connectionId,
        modelId: 'gpt-4.1',
        inputMicrosPerMillion: 2_000_000,
        outputMicrosPerMillion: 8_000_000,
      }),
    ).toEqual({
      connectionId,
      modelId: 'gpt-4.1',
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 8_000_000,
    });
    expect(
      costMicros(
        { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 8_000_000 },
        { inputTokens: 1, outputTokens: 1 },
      ),
    ).toBe(10);
    expect(
      costMicros(
        { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 0 },
        { inputTokens: 3, outputTokens: 9 },
      ),
    ).toBe(3);
  });

  it('rejects extra keys, blank models, and fractional rates', () => {
    expect(() =>
      parseModelPriceInput({
        connectionId,
        modelId: 'gpt-4.1',
        inputMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
        currency: 'USD',
      }),
    ).toThrow(TaskInputError);
    expect(() =>
      parseModelPriceInput({
        connectionId,
        modelId: ' ',
        inputMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
      }),
    ).toThrow(TaskInputError);
    expect(() =>
      parseModelPriceInput({
        connectionId,
        modelId: 'gpt-4.1',
        inputMicrosPerMillion: 1.5,
        outputMicrosPerMillion: 1,
      }),
    ).toThrow(TaskInputError);
  });
});

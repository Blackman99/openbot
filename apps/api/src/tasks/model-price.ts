import { TaskInputError } from './errors.js';

export const MODEL_PRICE_MICROS_PER_MILLION = 1_000_000;

export type ModelPriceRates = {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
};

export type ModelPriceVersion = ModelPriceRates & {
  id: string;
  workspaceId: string;
  connectionId: string;
  modelId: string;
};

export type ModelPriceInput = {
  connectionId: string;
  modelId: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseModelPriceInput(value: unknown): ModelPriceInput {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'connectionId,inputMicrosPerMillion,modelId,outputMicrosPerMillion'
  )
    throw new TaskInputError();
  if (typeof value.connectionId !== 'string' || !uuid.test(value.connectionId))
    throw new TaskInputError();
  if (typeof value.modelId !== 'string' || !value.modelId.trim() || value.modelId.length > 256)
    throw new TaskInputError();
  if (!integer(value.inputMicrosPerMillion) || !integer(value.outputMicrosPerMillion))
    throw new TaskInputError();
  return {
    connectionId: value.connectionId.toLowerCase(),
    modelId: value.modelId.trim(),
    inputMicrosPerMillion: value.inputMicrosPerMillion,
    outputMicrosPerMillion: value.outputMicrosPerMillion,
  };
}

export function costMicros(
  price: ModelPriceRates,
  usage: { inputTokens: number; outputTokens: number },
): number {
  return (
    pricedTokens(usage.inputTokens, price.inputMicrosPerMillion) +
    pricedTokens(usage.outputTokens, price.outputMicrosPerMillion)
  );
}

function pricedTokens(tokens: number, microsPerMillion: number): number {
  if (tokens <= 0 || microsPerMillion <= 0) return 0;
  const value = BigInt(tokens) * BigInt(microsPerMillion);
  const million = BigInt(MODEL_PRICE_MICROS_PER_MILLION);
  return Number((value + million - 1n) / million);
}

export type TokenUsageRecord = {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
};

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

export function recordTokenUsage(input: {
  provider?: { inputTokens: number; outputTokens: number } | null;
  localInput?: string;
  localOutput?: string;
}): TokenUsageRecord | undefined {
  if (input.provider) {
    const inputTokens = tokenCount(input.provider.inputTokens);
    const outputTokens = tokenCount(input.provider.outputTokens);
    if (inputTokens === undefined || outputTokens === undefined) return undefined;
    return { inputTokens, outputTokens, estimated: false };
  }
  if (input.localInput === undefined && input.localOutput === undefined) return undefined;
  return {
    inputTokens: estimateTokens(input.localInput ?? ''),
    outputTokens: estimateTokens(input.localOutput ?? ''),
    estimated: true,
  };
}

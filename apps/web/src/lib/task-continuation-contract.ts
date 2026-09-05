export const continuationReasons = [
  'provider_rate_limited',
  'provider_unavailable',
  'provider_connection_reset',
] as const;
export type ContinuationReason = (typeof continuationReasons)[number];
export type ContinuationOrigin = 'provider_retry' | 'model_fallback';
export interface SafeModelSnapshot {
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  modelId: string;
}
export interface RunContinuation {
  origin: ContinuationOrigin;
  reason: ContinuationReason;
  previousRunId: string;
  previousProvider: SafeModelSnapshot;
  nextProvider: SafeModelSnapshot;
  dueAt: string;
  admitted: boolean;
}

function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
}
function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function parseSafeModelSnapshot(value: unknown): SafeModelSnapshot | undefined {
  if (
    !keys(value, 'modelId,protocol') ||
    !text(value.modelId, 256) ||
    (value.protocol !== 'openai-chat' &&
      value.protocol !== 'openai-responses' &&
      value.protocol !== 'anthropic-messages')
  )
    return undefined;
  return { protocol: value.protocol, modelId: value.modelId };
}

export function parseRunContinuation(value: unknown): RunContinuation | undefined {
  if (
    !keys(value, 'admitted,dueAt,nextProvider,origin,previousProvider,previousRunId,reason') ||
    (value.admitted !== true && value.admitted !== false) ||
    (value.origin !== 'provider_retry' && value.origin !== 'model_fallback') ||
    !uuid(value.previousRunId) ||
    !date(value.dueAt)
  )
    return undefined;
  const reason = continuationReasons.find((code) => code === value.reason);
  const previousProvider = parseSafeModelSnapshot(value.previousProvider),
    nextProvider = parseSafeModelSnapshot(value.nextProvider);
  if (!reason || !previousProvider || !nextProvider) return undefined;
  return {
    origin: value.origin,
    reason,
    previousRunId: value.previousRunId.toLowerCase(),
    previousProvider,
    nextProvider,
    dueAt: value.dueAt,
    admitted: value.admitted,
  };
}

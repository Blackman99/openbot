import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { BotBinding } from '../bots/service.js';
import type { ProviderProtocol } from '../providers/model-events.js';
import { providerStorage } from '../providers/postgres-provider-scope.js';
import { readQueuedAuditMetadata } from './queued-audit.js';

export const CONTINUATION_REASONS = [
  'provider_rate_limited',
  'provider_unavailable',
  'provider_connection_reset',
] as const;
export const CONTINUATION_ORIGINS = ['provider_retry', 'model_fallback'] as const;
export type ContinuationReason = (typeof CONTINUATION_REASONS)[number];
export type ContinuationOrigin = (typeof CONTINUATION_ORIGINS)[number];
export interface SafeModelSnapshot {
  protocol: ProviderProtocol;
  modelId: string;
}
export interface RunContinuation {
  origin: ContinuationOrigin;
  reason: ContinuationReason;
  previousRunId: string;
  previousProvider: SafeModelSnapshot;
  nextProvider: SafeModelSnapshot;
  dueAt: Date;
  admitted: boolean;
}

const PROTOCOLS = new Set<ProviderProtocol>([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
]);

export function isContinuationReason(value: unknown): value is ContinuationReason {
  return typeof value === 'string' && (CONTINUATION_REASONS as readonly string[]).includes(value);
}

export function isContinuationOrigin(value: unknown): value is ContinuationOrigin {
  return typeof value === 'string' && (CONTINUATION_ORIGINS as readonly string[]).includes(value);
}

export function safeModelSnapshot(value: unknown): SafeModelSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'protocol' && key !== 'modelId')) return undefined;
  if (
    typeof record.protocol !== 'string' ||
    !PROTOCOLS.has(record.protocol as ProviderProtocol) ||
    typeof record.modelId !== 'string' ||
    !record.modelId.trim() ||
    record.modelId.length > 256
  )
    return undefined;
  return { protocol: record.protocol as ProviderProtocol, modelId: record.modelId };
}

export function wireContinuation(continuation: RunContinuation) {
  return {
    origin: continuation.origin,
    reason: continuation.reason,
    previousRunId: continuation.previousRunId,
    previousProvider: continuation.previousProvider,
    nextProvider: continuation.nextProvider,
    dueAt: continuation.dueAt.toISOString(),
    admitted: continuation.admitted,
  };
}

export async function readSafeModelSnapshot(
  connection: SqlConnection,
  binding: BotBinding,
): Promise<SafeModelSnapshot | undefined> {
  const { table, key } = providerStorage(binding.scope);
  const row = (
    await connection.query<{ protocol: string; model_id: string }>(
      `SELECT metadata->>'protocol' AS protocol, metadata->>'modelId' AS model_id FROM ${table} WHERE ${key}=$1 AND id=$2`,
      [binding.scope.id, binding.connectionId],
    )
  ).rows[0];
  if (!row || row.model_id !== binding.modelId) return undefined;
  return safeModelSnapshot({ protocol: row.protocol, modelId: row.model_id });
}

export async function loadRunContinuations(
  connection: SqlConnection,
  runs: { id: string; protocol: ProviderProtocol | null; modelId: string | null }[],
): Promise<Map<string, RunContinuation>> {
  const found = new Map<string, RunContinuation>();
  for (const run of runs) {
    const continuation = await loadRunContinuation(connection, run);
    if (continuation) found.set(run.id, continuation);
  }
  return found;
}

export async function loadRunContinuation(
  connection: SqlConnection,
  run: { id: string; protocol: ProviderProtocol | null; modelId: string | null },
): Promise<RunContinuation | undefined> {
  const metadata = await readQueuedAuditMetadata(connection, run.id);
  if (!isContinuationOrigin(metadata?.origin) || !isContinuationReason(metadata?.reason))
    return undefined;
  if (typeof metadata.previousRunId !== 'string' || typeof metadata.notBefore !== 'string')
    return undefined;
  const previousProvider = safeModelSnapshot(metadata.previousProvider);
  const planned = safeModelSnapshot(metadata.nextProvider);
  const dueAt = new Date(metadata.notBefore);
  if (!previousProvider || !planned || !Number.isFinite(dueAt.getTime())) return undefined;
  const admitted = !!(run.protocol && run.modelId);
  return {
    origin: metadata.origin,
    reason: metadata.reason,
    previousRunId: metadata.previousRunId,
    previousProvider,
    nextProvider: admitted ? { protocol: run.protocol!, modelId: run.modelId! } : planned,
    dueAt,
    admitted,
  };
}

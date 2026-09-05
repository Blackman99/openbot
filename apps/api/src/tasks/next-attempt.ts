import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { BotBinding } from '../bots/service.js';
import { appendQueuedRunState } from '../conversations/append-event.js';
import type { ProviderProtocol } from '../providers/model-events.js';
import { lockTaskAncestry } from './tree.js';
import { readSafeModelSnapshot, safeModelSnapshot } from './continuation.js';
import { type AttemptOrigin, type ChainAttempt, type NextAttemptPlan } from './retry-schedule.js';

const ORIGINS = new Set<AttemptOrigin>([
  'initial',
  'manual_retry',
  'provider_retry',
  'model_fallback',
  'worker_recovery',
]);

export interface AttemptChain {
  rootRunId: string;
  previousRunId: string;
  attempts: ChainAttempt[];
}

export type NextAttemptWrite =
  { scheduled: true; runId: string } | { scheduled: false; reason: 'cancelled' | 'duplicate' };

export async function loadAttemptChain(
  connection: SqlConnection,
  taskId: string,
  sourceRunId: string,
): Promise<AttemptChain> {
  const runs = (
    await connection.query<{
      id: string;
      attempt: number;
      connection_id: string | null;
      model_id: string | null;
    }>(
      'SELECT id,attempt,connection_id,model_id FROM task_runs WHERE task_id=$1 ORDER BY attempt',
      [taskId],
    )
  ).rows;
  const retry = (
    await connection.query<{ run_id: string }>(
      'SELECT run_id FROM task_retry_commands WHERE task_id=$1 ORDER BY created_at DESC,run_id DESC LIMIT 1',
      [taskId],
    )
  ).rows[0];
  const rootRunId = retry?.run_id ?? runs[0]!.id;
  const start = Math.max(
    0,
    runs.findIndex((run) => run.id === rootRunId),
  );
  const queued = await queuedMetadataByRun(connection, taskId);
  const attempts: ChainAttempt[] = [];
  for (const run of runs.slice(start)) {
    const metadata = queued.get(run.id);
    const binding = bindingFromMetadata(metadata);
    const connectionId = run.connection_id ?? binding?.connectionId;
    const modelId = run.model_id ?? binding?.modelId;
    if (!connectionId || !modelId) continue;
    const recorded = metadata?.origin;
    attempts.push({
      runId: run.id,
      connectionId,
      modelId,
      origin:
        typeof recorded === 'string' && ORIGINS.has(recorded as AttemptOrigin)
          ? (recorded as AttemptOrigin)
          : retry?.run_id === run.id
            ? 'manual_retry'
            : attempts.length === 0
              ? 'initial'
              : 'provider_retry',
    });
  }
  return { rootRunId, previousRunId: sourceRunId, attempts };
}

export async function readPlannedNotBefore(
  connection: SqlConnection,
  runId: string,
): Promise<Date | undefined> {
  const metadata = await queuedMetadata(connection, runId);
  if (typeof metadata?.notBefore !== 'string') return undefined;
  const at = Date.parse(metadata.notBefore);
  return Number.isFinite(at) ? new Date(at) : undefined;
}

export async function readPlannedBinding(
  connection: SqlConnection,
  runId: string,
): Promise<BotBinding | undefined> {
  const metadata = await queuedMetadata(connection, runId);
  if (metadata?.origin !== 'provider_retry' && metadata?.origin !== 'model_fallback')
    return undefined;
  return bindingFromMetadata(metadata);
}

export async function writeNextAttempt(
  connection: SqlConnection,
  input: {
    taskId: string;
    sourceRunId: string;
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    sourceAttempt: number;
    plan: NextAttemptPlan;
    now: Date;
  },
): Promise<NextAttemptWrite> {
  if (!(await lockTaskAncestry(connection, input.taskId)))
    return { scheduled: false, reason: 'cancelled' };
  const source = (
    await connection.query<{ id: string; attempt: number; status: string }>(
      'SELECT id,attempt,status FROM task_runs WHERE task_id=$1 ORDER BY attempt FOR UPDATE',
      [input.taskId],
    )
  ).rows;
  const latest = source.at(-1);
  if (
    !latest ||
    latest.status !== 'failed' ||
    latest.id !== input.sourceRunId ||
    source.some((run) => run.attempt > input.sourceAttempt)
  )
    return { scheduled: false, reason: 'duplicate' };
  const previous = (
    await connection.query<{ protocol: ProviderProtocol | null; model_id: string | null }>(
      'SELECT protocol, model_id FROM task_runs WHERE id=$1',
      [input.sourceRunId],
    )
  ).rows[0];
  const previousProvider = safeModelSnapshot({
    protocol: previous?.protocol,
    modelId: previous?.model_id,
  });
  const nextProvider = await readSafeModelSnapshot(connection, input.plan.binding);
  const runId = randomUUID();
  await connection.query(
    "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,$3,'queued',$4)",
    [runId, input.taskId, input.sourceAttempt + 1, input.now],
  );
  await connection.query("UPDATE tasks SET status='queued' WHERE id=$1", [input.taskId]);
  await connection.query(
    'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [
      randomUUID(),
      'task.queued',
      input.executionUserId,
      input.now,
      JSON.stringify({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        runId,
        attempt: input.sourceAttempt + 1,
        origin: input.plan.origin,
        sourceRunId: input.sourceRunId,
        previousRunId: input.plan.previousRunId,
        reason: input.plan.reason,
        notBefore: input.plan.notBefore.toISOString(),
        binding: input.plan.binding,
        previousBinding: input.plan.previousBinding,
        ...(previousProvider && nextProvider ? { previousProvider, nextProvider } : {}),
        chainRootRunId: input.plan.chainRootRunId,
        chainAttemptOrdinal: input.plan.chainAttemptOrdinal,
        chainLimitSnapshot: input.plan.chainLimitSnapshot,
        modelAttemptOrdinal: input.plan.modelAttemptOrdinal,
      }),
    ],
  );
  await appendQueuedRunState(connection, runId, () => input.now);
  return { scheduled: true, runId };
}

async function queuedMetadata(connection: SqlConnection, runId: string) {
  const row = (
    await connection.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1 ORDER BY occurred_at DESC LIMIT 1",
      [runId],
    )
  ).rows[0];
  return asRecord(row?.metadata);
}

async function queuedMetadataByRun(connection: SqlConnection, taskId: string) {
  const rows = (
    await connection.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'taskId'=$1",
      [taskId],
    )
  ).rows;
  const byRun = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const metadata = asRecord(row.metadata);
    if (typeof metadata?.runId === 'string') byRun.set(metadata.runId, metadata);
  }
  return byRun;
}

function bindingFromMetadata(metadata?: Record<string, unknown>): BotBinding | undefined {
  const binding = asRecord(metadata?.binding);
  const scope = asRecord(binding?.scope);
  if (
    !binding ||
    typeof binding.connectionId !== 'string' ||
    typeof binding.modelId !== 'string' ||
    (scope?.kind !== 'personal' && scope?.kind !== 'workspace') ||
    typeof scope.id !== 'string'
  )
    return undefined;
  return {
    scope: { kind: scope.kind, id: scope.id },
    connectionId: binding.connectionId,
    modelId: binding.modelId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

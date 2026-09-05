import type { SqlConnection } from '../auth/postgres-auth-repository.js';

export async function readQueuedAuditMetadata(
  connection: SqlConnection,
  runId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const row = (
      await connection.query<{ metadata: unknown }>(
        'SELECT task_queued_audit_metadata($1::uuid) AS metadata',
        [runId],
      )
    ).rows[0];
    return asRecord(row?.metadata);
  } catch (error) {
    if (!missingSqlFunction(error, 'task_queued_audit_metadata')) throw error;
  }
  const row = (
    await connection.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1 ORDER BY occurred_at DESC LIMIT 1",
      [runId],
    )
  ).rows[0];
  return asRecord(row?.metadata);
}

export async function readQueuedAuditMetadataForTask(
  connection: SqlConnection,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  try {
    const rows = (
      await connection.query<{ metadata: unknown }>(
        'SELECT task_queued_audit_metadata_for_task($1::uuid) AS metadata',
        [taskId],
      )
    ).rows;
    return rows.map((row) => asRecord(row.metadata)).filter((row) => row !== undefined);
  } catch (error) {
    if (!missingSqlFunction(error, 'task_queued_audit_metadata_for_task')) throw error;
  }
  const rows = (
    await connection.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'taskId'=$1",
      [taskId],
    )
  ).rows;
  return rows.map((row) => asRecord(row.metadata)).filter((row) => row !== undefined);
}

function missingSqlFunction(error: unknown, name: string): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === '42883' || message.includes(name);
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

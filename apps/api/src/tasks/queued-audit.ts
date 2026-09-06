import type { SqlConnection } from '../auth/postgres-auth-repository.js';

export async function readQueuedAuditMetadata(
  connection: SqlConnection,
  runId: string,
): Promise<Record<string, unknown> | undefined> {
  const viaFunction = await probe(
    connection,
    () =>
      connection.query<{ metadata: unknown }>(
        'SELECT task_queued_audit_metadata($1::uuid) AS metadata',
        [runId],
      ),
    'task_queued_audit_metadata',
  );
  if (viaFunction !== 'absent') return asRecord(viaFunction.rows[0]?.metadata);
  const viaTable = await probe(
    connection,
    () =>
      connection.query<{ metadata: unknown }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1::text ORDER BY occurred_at DESC LIMIT 1",
        [runId],
      ),
    'audit_events',
  );
  if (viaTable === 'absent') return undefined;
  return asRecord(viaTable.rows[0]?.metadata);
}

export async function readQueuedAuditMetadataForTask(
  connection: SqlConnection,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  const viaFunction = await probe(
    connection,
    () =>
      connection.query<{ metadata: unknown }>(
        'SELECT task_queued_audit_metadata_for_task($1::uuid) AS metadata',
        [taskId],
      ),
    'task_queued_audit_metadata_for_task',
  );
  if (viaFunction !== 'absent')
    return viaFunction.rows.map((row) => asRecord(row.metadata)).filter((row) => row !== undefined);
  const viaTable = await probe(
    connection,
    () =>
      connection.query<{ metadata: unknown }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'taskId'=$1::text",
        [taskId],
      ),
    'audit_events',
  );
  if (viaTable === 'absent') return [];
  return viaTable.rows.map((row) => asRecord(row.metadata)).filter((row) => row !== undefined);
}

async function probe<T>(
  connection: SqlConnection,
  action: () => Promise<T>,
  absentName: string,
): Promise<T | 'absent'> {
  const isolated = await withSavepoint(connection, action);
  if (isolated.ok) return isolated.value;
  if (isAbsent(isolated.error, absentName)) return 'absent';
  throw isolated.error;
}

async function withSavepoint<T>(
  connection: SqlConnection,
  action: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    await connection.query('SAVEPOINT col10_queued_audit');
  } catch {
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      return { ok: false, error };
    }
  }
  try {
    const value = await action();
    await connection.query('RELEASE SAVEPOINT col10_queued_audit');
    return { ok: true, value };
  } catch (error) {
    try {
      await connection.query('ROLLBACK TO SAVEPOINT col10_queued_audit');
    } catch {
      // Preserve the original probe error even if rollback also fails.
    }
    return { ok: false, error };
  }
}

function isAbsent(error: unknown, name: string): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === '42883' || code === '42501' || code === '42P01' || message.includes(name);
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

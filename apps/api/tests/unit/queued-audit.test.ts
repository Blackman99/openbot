import { describe, expect, it } from 'vitest';
import type { SqlConnection } from '../../src/auth/postgres-auth-repository.js';
import {
  readQueuedAuditMetadata,
  readQueuedAuditMetadataForTask,
} from '../../src/tasks/queued-audit.js';

type Query = { statement: string; parameters?: unknown[] };
type QueryResult = { rowCount: number | null; rows: Record<string, unknown>[] };

function sqlError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function connection(handler: (query: Query) => Promise<QueryResult>): SqlConnection & {
  queries: Query[];
} {
  const queries: Query[] = [];
  return {
    queries,
    query: async (statement: string, parameters?: unknown[]) => {
      const query: Query =
        parameters === undefined ? { statement } : { statement, parameters };
      queries.push(query);
      return handler(query);
    },
    release() {},
  };
}

function emptyResult(): QueryResult {
  return { rowCount: 0, rows: [] };
}

describe('queued audit metadata readers', () => {
  it('uses the DEFINER helper when it exists and does not SELECT audit_events', async () => {
    const db = connection(async (query) => {
      if (query.statement.startsWith('SAVEPOINT') || query.statement.startsWith('RELEASE'))
        return emptyResult();
      if (query.statement.includes('task_queued_audit_metadata('))
        return {
          rowCount: 1,
          rows: [{ metadata: { origin: 'provider_retry', runId: 'run-1' } }],
        };
      throw new Error(`unexpected ${query.statement}`);
    });
    await expect(readQueuedAuditMetadata(db, 'run-1')).resolves.toEqual({
      origin: 'provider_retry',
      runId: 'run-1',
    });
    expect(db.queries.map((query) => query.statement).join('\n')).not.toContain(
      'FROM audit_events',
    );
  });

  it('rolls the missing-function probe back to its savepoint then reads the table', async () => {
    const db = connection(async (query) => {
      if (query.statement.startsWith('SAVEPOINT') || query.statement.startsWith('RELEASE'))
        return emptyResult();
      if (query.statement.startsWith('ROLLBACK TO SAVEPOINT')) return emptyResult();
      if (query.statement.includes('task_queued_audit_metadata('))
        throw sqlError('42883', 'function task_queued_audit_metadata(uuid) does not exist');
      if (query.statement.includes('FROM audit_events'))
        return {
          rowCount: 1,
          rows: [{ metadata: { origin: 'initial', runId: 'run-1' } }],
        };
      throw new Error(`unexpected ${query.statement}`);
    });
    await expect(readQueuedAuditMetadata(db, 'run-1')).resolves.toEqual({
      origin: 'initial',
      runId: 'run-1',
    });
    expect(db.queries.map((query) => query.statement)).toEqual([
      'SAVEPOINT col10_queued_audit',
      'SELECT task_queued_audit_metadata($1::uuid) AS metadata',
      'ROLLBACK TO SAVEPOINT col10_queued_audit',
      'SAVEPOINT col10_queued_audit',
      "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1 ORDER BY occurred_at DESC LIMIT 1",
      'RELEASE SAVEPOINT col10_queued_audit',
    ]);
  });

  it('returns no metadata when the helper is absent and audit SELECT is denied', async () => {
    const db = connection(async (query) => {
      if (query.statement.startsWith('SAVEPOINT') || query.statement.startsWith('ROLLBACK'))
        return emptyResult();
      if (query.statement.includes('task_queued_audit_metadata_for_task('))
        throw sqlError(
          '42883',
          'function task_queued_audit_metadata_for_task(uuid) does not exist',
        );
      if (query.statement.includes('FROM audit_events'))
        throw sqlError('42501', 'permission denied for table audit_events');
      throw new Error(`unexpected ${query.statement}`);
    });
    await expect(readQueuedAuditMetadataForTask(db, 'task-1')).resolves.toEqual([]);
  });

  it('rethrows unexpected helper errors after rolling the probe back', async () => {
    const db = connection(async (query) => {
      if (query.statement.startsWith('SAVEPOINT') || query.statement.startsWith('ROLLBACK'))
        return emptyResult();
      if (query.statement.includes('task_queued_audit_metadata('))
        throw sqlError('57014', 'canceling statement due to statement timeout');
      throw new Error(`unexpected ${query.statement}`);
    });
    await expect(readQueuedAuditMetadata(db, 'run-1')).rejects.toMatchObject({ code: '57014' });
    expect(db.queries.map((query) => query.statement)).toContain(
      'ROLLBACK TO SAVEPOINT col10_queued_audit',
    );
  });
});

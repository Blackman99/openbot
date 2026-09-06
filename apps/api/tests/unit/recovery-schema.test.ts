import { describe, expect, it } from 'vitest';
import {
  COL11_RECOVERY_REQUIRES_VERSION,
  TASK_RECOVERY_SCHEMA_STATEMENTS,
} from '../../src/tasks/recovery-schema.js';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import { CLAIM_HEARTBEAT_MS, CLAIM_LEASE_MS, leaseExpiry } from '../../src/tasks/lease.js';

describe('COL-11 recovery schema first slice', () => {
  const sql = TASK_RECOVERY_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after resume commands and admits worker interruption', () => {
    expect(COL11_RECOVERY_REQUIRES_VERSION).toBe('0035_task_run_recovery');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0036_task_execution_limit_snapshots');
    expect(sql).toContain('worker_interrupted');
    expect(sql).toContain('CREATE TABLE task_run_leases');
    expect(sql).toContain('CREATE TABLE task_run_recovery_receipts');
    expect(sql).toContain("decision IN ('queued_successor','stopped')");
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(CLAIM_LEASE_MS).toBe(15_000);
    expect(CLAIM_HEARTBEAT_MS).toBe(1_000);
    const now = new Date('2026-09-06T01:00:00.000Z');
    expect(leaseExpiry(now, new Date(now.getTime() + 60_000))).toEqual(
      new Date(now.getTime() + CLAIM_LEASE_MS),
    );
    expect(leaseExpiry(now, new Date(now.getTime() + 5_000))).toEqual(
      new Date(now.getTime() + 5_000),
    );
  });
});

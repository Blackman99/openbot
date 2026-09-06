import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL12_LIMITS_REQUIRES_VERSION,
  TASK_EXECUTION_LIMIT_SCHEMA_STATEMENTS,
} from '../../src/tasks/execution-limit-schema.js';
import { COL12_LIMITS_POSTGRES_GUARDS } from '../../src/tasks/col12-postgres-guards.js';

describe('COL-12 execution limit schema first slice', () => {
  const sql = TASK_EXECUTION_LIMIT_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after recovery and stores immutable starting snapshots', () => {
    expect(COL12_LIMITS_REQUIRES_VERSION).toBe('0036_task_execution_limit_snapshots');
    expect(MIGRATION_VERSIONS).toContain('0036_task_execution_limit_snapshots');
    expect(MIGRATION_VERSIONS).toContain('0037_task_execution_limit_enforcement');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0038_task_run_concurrency_holds');
    expect(sql).toContain('ALTER TABLE workspaces ADD COLUMN execution_policy');
    expect(sql).toContain('ALTER TABLE groups ADD COLUMN execution_policy');
    expect(sql).not.toContain('GRANT UPDATE');
    expect(sql).toContain('CREATE TABLE task_execution_limit_snapshots');
    expect(sql).toContain(
      "duration_source TEXT NOT NULL CHECK(duration_source IN ('workspace','group','task','run'))",
    );
    expect(sql).toContain('max_duration_ms');
    expect(sql).toContain('max_handoffs');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
  });

  it('guards snapshot identity with a repeatable overlay, not a second ledger version', () => {
    const overlay = COL12_LIMITS_POSTGRES_GUARDS.join('\n');
    expect(overlay).toContain('CREATE OR REPLACE FUNCTION protect_task_execution_limit_snapshot()');
    expect(overlay).toContain('Task execution limit snapshots are immutable');
    expect(overlay).not.toContain('INSERT INTO openbot_schema_migrations');
  });
});

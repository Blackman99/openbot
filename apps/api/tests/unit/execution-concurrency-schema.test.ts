import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL13_CONCURRENCY_REQUIRES_VERSION,
  TASK_RUN_CONCURRENCY_SCHEMA_STATEMENTS,
} from '../../src/tasks/execution-concurrency-schema.js';

describe('COL-13 concurrency hold schema', () => {
  const sql = TASK_RUN_CONCURRENCY_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after enforcement and stores live queue holds', () => {
    expect(COL13_CONCURRENCY_REQUIRES_VERSION).toBe('0038_task_run_concurrency_holds');
    expect(MIGRATION_VERSIONS).toContain('0037_task_execution_limit_enforcement');
    expect(MIGRATION_VERSIONS).toContain('0038_task_run_concurrency_holds');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0042_task_token_budgets');
    expect(sql).toContain('ALTER TABLE tasks ADD COLUMN execution_policy');
    expect(sql).toContain('CREATE TABLE task_run_concurrency_holds');
    expect(sql).toContain("layer TEXT NOT NULL CHECK (layer IN ('workspace','group','task'))");
    expect(sql).toContain('max_concurrent_runs INTEGER NOT NULL CHECK (max_concurrent_runs>=1)');
    expect(sql).not.toContain('GRANT UPDATE');
    expect(sql).not.toContain('waiting_budget');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
  });
});

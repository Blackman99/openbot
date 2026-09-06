import { describe, expect, it } from 'vitest';
import {
  COL12_LIMITS_POSTGRES_GUARDS,
  COL12_LIMITS_REQUIRES_VERSION,
} from '../../src/tasks/col12-postgres-guards.js';

describe('COL-12 execution limit PostgreSQL overlay', () => {
  const sql = COL12_LIMITS_POSTGRES_GUARDS.join('\n');

  it('is a repeatable CREATE OR REPLACE overlay after 0036, not a new ledger version', () => {
    expect(COL12_LIMITS_REQUIRES_VERSION).toBe('0036_task_execution_limit_snapshots');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION task_has_budget_grant_receipt');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task_run()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION require_current_task_run()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task_execution_limit_snapshot()');
    expect(sql).toContain('Task execution limit snapshots are immutable');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).toContain('SECURITY DEFINER');
  });

  it('admits waiting_budget hold and budget_grant resume while retaining earlier receipts', () => {
    expect(sql).toContain("'waiting_budget'");
    expect(sql).toContain("origin'='budget_grant'");
    expect(sql).toContain('task_has_budget_grant_receipt');
    expect(sql).toContain('task_has_automatic_continuation_receipt');
    expect(sql).toContain('task_has_manual_resume_receipt');
    expect(sql).toContain('worker_recovery');
    expect(sql).toContain("OLD.status='waiting_budget' AND NEW.status='queued'");
    expect(sql).toContain('Task budget grant requires a new Run and its immutable receipt');
    expect(sql).toContain('waiting_budget Task requires a retained current Run');
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION lock_task_ancestry(target UUID, allow_paused BOOLEAN)',
    );
    expect(sql).toContain("status IN ('paused','waiting_budget')");
    expect(sql).toContain(
      "NOT IN ('manual_resume','budget_grant','provider_retry','model_fallback','worker_recovery')",
    );
  });
});

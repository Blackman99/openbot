import { describe, expect, it } from 'vitest';
import {
  COL11_RECOVERY_POSTGRES_GUARDS,
  COL11_RECOVERY_REQUIRES_VERSION,
} from '../../src/tasks/col11-postgres-guards.js';

describe('COL-11 recovery PostgreSQL overlay', () => {
  const sql = COL11_RECOVERY_POSTGRES_GUARDS.join('\n');

  it('is a repeatable CREATE OR REPLACE overlay after 0035, not a new ledger version', () => {
    expect(COL11_RECOVERY_REQUIRES_VERSION).toBe('0035_task_run_recovery');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION task_has_automatic_continuation_receipt');
    expect(sql).toContain("origin' IN ('provider_retry','model_fallback','worker_recovery')");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task_run_lease()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task_run_recovery_receipt()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION fence_expired_claim_publication()');
    expect(sql).toContain('expired Task Run lease cannot be renewed');
    expect(sql).toContain('expired Task Run lease cannot publish');
    expect(sql).toContain('worker interruption requires an expired lease');
    expect(sql).toContain('Task Run recovery receipts are immutable');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).toContain('SECURITY DEFINER');
  });
});

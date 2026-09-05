import { describe, expect, it } from 'vitest';
import {
  COL10_AUTOMATIC_ATTEMPT_POSTGRES_GUARDS,
  COL10_AUTOMATIC_ATTEMPT_REQUIRES_VERSION,
} from '../../src/tasks/col10-postgres-guards.js';

describe('COL-10 automatic-attempt PostgreSQL overlay', () => {
  const sql = COL10_AUTOMATIC_ATTEMPT_POSTGRES_GUARDS.join('\n');

  it('is a repeatable CREATE OR REPLACE overlay after 0023, not a new ledger version', () => {
    expect(COL10_AUTOMATIC_ATTEMPT_REQUIRES_VERSION).toBe('0023_task_tree_cancellation');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task_run()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION require_current_task_run()');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
  });

  it('reads continuation receipts through SECURITY DEFINER helpers, not runtime table SELECT', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION task_has_automatic_continuation_receipt');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION task_queued_audit_metadata');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain(
      'task_has_automatic_continuation_receipt(NEW.id, latest.id, NEW.execution_user_id)',
    );
    expect(sql).toContain('task_run_has_listed_continuation_binding(');
    expect(sql).toContain('fallbackBindings');
    expect(sql).toContain('Task retry requires a new Run and its immutable receipt');
    expect(sql).toContain('Run must retain its admitted model binding');
    expect(sql).toContain('Task identity and completed/cancelled state are immutable');
    expect(sql).toContain('Run identity and terminal state are immutable');
    expect(sql).toContain('task_retry_commands');
  });
});

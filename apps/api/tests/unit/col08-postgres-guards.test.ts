import { describe, expect, it } from 'vitest';
import {
  COL08_PAUSE_POSTGRES_GUARDS,
  COL08_PAUSE_REQUIRES_VERSION,
} from '../../src/tasks/col08-postgres-guards.js';

describe('COL-08 pause/resume PostgreSQL overlay', () => {
  const sql = COL08_PAUSE_POSTGRES_GUARDS.join('\n');

  it('is a repeatable CREATE OR REPLACE overlay after 0033, not a new ledger version', () => {
    expect(COL08_PAUSE_REQUIRES_VERSION).toBe('0033_task_pause_checkpoints');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION protect_task_run()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION require_current_task_run()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION task_has_manual_resume_receipt');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
  });

  it('admits queued and running pause plus paused resume while retaining COL-10 receipts', () => {
    expect(sql).toContain(
      "OLD.status='queued' AND NEW.status IN ('running','failed','cancelled','paused')",
    );
    expect(sql).toContain(
      "OLD.status='running' AND NEW.status IN ('completed','failed','cancelled','paused')",
    );
    expect(sql).toContain("OLD.status='paused' AND NEW.status='queued'");
    expect(sql).toContain("parent.status='paused' AND latest.status='paused'");
    expect(sql).toContain('task_run_pauses');
    expect(sql).toContain('task_run_pause_checkpoints');
    expect(sql).toContain("strategy='restart_from_task_input_v1'");
    expect(sql).toContain(
      'paused Run requires its exact command marker, checkpoint, retained claim and usage',
    );
    expect(sql).toContain('Task resume requires a new Run and its immutable receipt');
    expect(sql).toContain("origin'='manual_resume'");
    expect(sql).toContain('task_has_automatic_continuation_receipt');
    expect(sql).toContain('task_has_manual_resume_receipt');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION task_has_manual_resume_receipt(uuid,uuid,uuid) FROM PUBLIC',
    );
    expect(sql).toContain('Task retry requires a new Run and its immutable receipt');
    expect(sql).toContain(
      'cancelled Run requires its exact command marker, retained claim and usage',
    );
  });
});

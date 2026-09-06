import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL19_HUMAN_REQUEST_POSTGRES_GUARDS,
  COL19_HUMAN_REQUEST_REQUIRES_VERSION,
} from '../../src/tasks/col19-postgres-guards.js';
import { TASK_HUMAN_REQUEST_SCHEMA_STATEMENTS } from '../../src/tasks/human-request-schema.js';
import { COL16_HANDOFF_POSTGRES_GUARDS } from '../../src/tasks/col16-postgres-guards.js';

describe('COL-19 human request schema slice', () => {
  const sql = TASK_HUMAN_REQUEST_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after cost budgets and admits waiting human holds', () => {
    expect(COL19_HUMAN_REQUEST_REQUIRES_VERSION).toBe('0047_task_human_requests');
    expect(MIGRATION_VERSIONS).toContain('0046_task_cost_budgets');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0052_routine_occurrences');
    expect(sql).toContain('waiting_input');
    expect(sql).toContain('waiting_approval');
    expect(sql).toContain('CREATE TABLE task_human_requests');
    expect(sql).toContain('CREATE TABLE task_human_decisions');
    expect(sql).toContain("'task.input.requested'");
    expect(sql).toContain("'task.approval.requested'");
    expect(sql).toContain("'task.human.decided'");
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
    expect(sql).not.toContain('length(');
  });

  it('replaces COL-16 as overlay last and keeps automatic continuation origins', () => {
    const overlay = COL19_HUMAN_REQUEST_POSTGRES_GUARDS.join('\n');
    expect(COL19_HUMAN_REQUEST_REQUIRES_VERSION).toBe('0047_task_human_requests');
    expect(overlay).toContain('task_has_human_decision_receipt');
    expect(overlay).toContain("'human_decision'");
    expect(overlay).toContain('waiting_input');
    expect(overlay).toContain('waiting_approval');
    expect(overlay).toContain("'task.input.requested'");
    expect(overlay).toContain("'task.approval.requested'");
    expect(overlay).toContain("'task.human.decided'");
    expect(overlay).toContain(
      "NOT IN ('manual_resume','budget_grant','provider_retry','model_fallback','worker_recovery','child_result','handoff','human_decision')",
    );
    expect(overlay).not.toContain(
      'CREATE OR REPLACE FUNCTION task_has_automatic_continuation_receipt',
    );
    expect(COL16_HANDOFF_POSTGRES_GUARDS.join('\n')).not.toContain('human_decision');
  });
});

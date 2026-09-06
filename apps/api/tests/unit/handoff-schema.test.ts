import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL16_HANDOFF_REQUIRES_VERSION,
  TASK_HANDOFF_SCHEMA_STATEMENTS,
} from '../../src/tasks/handoff-schema.js';

describe('COL-16 handoff schema slice', () => {
  const sql = TASK_HANDOFF_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after parallel delegations and records one Lead transfer', () => {
    expect(COL16_HANDOFF_REQUIRES_VERSION).toBe('0044_task_lead_handoffs');
    expect(MIGRATION_VERSIONS).toContain('0043_task_parallel_delegations');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0048_task_cost_grants');
    expect(sql).toContain('CREATE TABLE task_handoffs');
    expect(sql).toContain('handed_off');
    expect(sql).toContain("'task.handoff'");
    expect(sql).toContain("reason VARCHAR(8000) NOT NULL CHECK (reason<>'')");
    expect(sql).toContain('CHECK (source_grant_id<>target_grant_id)');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
  });
});

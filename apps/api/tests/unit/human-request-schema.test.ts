import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL19_HUMAN_REQUEST_REQUIRES_VERSION,
  TASK_HUMAN_REQUEST_SCHEMA_STATEMENTS,
} from '../../src/tasks/human-request-schema.js';

describe('COL-19 human request schema slice', () => {
  const sql = TASK_HUMAN_REQUEST_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after cost budgets and admits waiting human holds', () => {
    expect(COL19_HUMAN_REQUEST_REQUIRES_VERSION).toBe('0047_task_human_requests');
    expect(MIGRATION_VERSIONS).toContain('0046_task_cost_budgets');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0049_group_archive');
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
});

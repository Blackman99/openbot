import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL15_PARALLEL_DELEGATION_REQUIRES_VERSION,
  TASK_PARALLEL_DELEGATION_SCHEMA_STATEMENTS,
} from '../../src/tasks/parallel-delegation-schema.js';

describe('COL-15 parallel delegation schema slice', () => {
  const sql = TASK_PARALLEL_DELEGATION_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after token budgets and admits many children per parent Run', () => {
    expect(COL15_PARALLEL_DELEGATION_REQUIRES_VERSION).toBe('0043_task_parallel_delegations');
    expect(MIGRATION_VERSIONS).toContain('0042_task_token_budgets');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0050_workspace_event_stream');
    expect(sql).toContain('CREATE TABLE task_delegations_parallel');
    expect(sql).toContain('PRIMARY KEY (parent_run_id, child_task_id)');
    expect(sql).toContain('UNIQUE (parent_run_id, action_id)');
    expect(sql).toContain('ALTER TABLE task_delegations_parallel RENAME TO task_delegations');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
  });
});

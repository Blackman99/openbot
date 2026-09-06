import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL18_COST_GRANT_REQUIRES_VERSION,
  TASK_COST_GRANT_SCHEMA_STATEMENTS,
} from '../../src/tasks/cost-grant-schema.js';

describe('COL-18 cost grant schema slice', () => {
  const sql = TASK_COST_GRANT_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after human requests and admits cost grants', () => {
    expect(COL18_COST_GRANT_REQUIRES_VERSION).toBe('0048_task_cost_grants');
    expect(MIGRATION_VERSIONS).toContain('0047_task_human_requests');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0049_group_archive');
    expect(sql).toContain("dimension IN ('duration','turns','delegationDepth','handoffs','cost')");
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
  });
});

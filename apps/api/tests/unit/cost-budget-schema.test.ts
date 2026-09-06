import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL18_COST_BUDGET_REQUIRES_VERSION,
  TASK_COST_BUDGET_SCHEMA_STATEMENTS,
} from '../../src/tasks/cost-budget-schema.js';

describe('COL-18 cost budget schema slice', () => {
  const sql = TASK_COST_BUDGET_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after prices and stores used plus reserved micros', () => {
    expect(COL18_COST_BUDGET_REQUIRES_VERSION).toBe('0046_task_cost_budgets');
    expect(MIGRATION_VERSIONS).toContain('0045_model_price_versions');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0049_group_archive');
    expect(sql).toContain('CREATE TABLE task_cost_ledgers');
    expect(sql).toContain('CREATE TABLE task_cost_reservations');
    expect(sql).toContain("scope_kind IN ('workspace','group','task')");
    expect(sql).not.toContain("'run'");
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
  });
});

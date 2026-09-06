import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL17_TOKEN_BUDGET_REQUIRES_VERSION,
  TASK_TOKEN_BUDGET_SCHEMA_STATEMENTS,
} from '../../src/tasks/token-budget-schema.js';

describe('COL-17 token budget schema slice', () => {
  const sql = TASK_TOKEN_BUDGET_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after token usage and stores used plus reserved', () => {
    expect(COL17_TOKEN_BUDGET_REQUIRES_VERSION).toBe('0042_task_token_budgets');
    expect(MIGRATION_VERSIONS).toContain('0041_task_token_usage');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0048_task_cost_grants');
    expect(sql).toContain('CREATE TABLE task_token_ledgers');
    expect(sql).toContain('CREATE TABLE task_token_reservations');
    expect(sql).toContain("scope_kind IN ('workspace','group','task','run')");
    expect(sql).toContain('reserved_input_tokens');
    expect(sql).toContain('reserved_output_tokens');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
  });
});

import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL17_TOKEN_USAGE_REQUIRES_VERSION,
  TASK_TOKEN_USAGE_SCHEMA_STATEMENTS,
} from '../../src/tasks/token-usage-schema.js';

describe('COL-17 token usage schema slice', () => {
  const sql = TASK_TOKEN_USAGE_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after delegation and pairs estimated with tokens', () => {
    expect(COL17_TOKEN_USAGE_REQUIRES_VERSION).toBe('0041_task_token_usage');
    expect(MIGRATION_VERSIONS).toContain('0040_task_delegation');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0041_task_token_usage');
    expect(sql).toContain('ADD COLUMN usage_estimated BOOLEAN');
    expect(sql).toContain('task_runs_usage_estimated');
    expect(sql).toContain('usage_estimated IS NOT NULL');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
  });
});

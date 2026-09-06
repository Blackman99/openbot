import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  API03_GROUP_ARCHIVE_REQUIRES_VERSION,
  GROUP_ARCHIVE_SCHEMA_STATEMENTS,
} from '../../src/groups/archive-schema.js';

describe('API-03 group archive schema slice', () => {
  const sql = GROUP_ARCHIVE_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after cost budgets and adds archive plus concurrency columns', () => {
    expect(API03_GROUP_ARCHIVE_REQUIRES_VERSION).toBe('0049_group_archive');
    expect(MIGRATION_VERSIONS).toContain('0048_task_cost_grants');
    expect(MIGRATION_VERSIONS).toContain('0049_group_archive');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0050_workspace_event_stream');
    expect(sql).toContain('ALTER TABLE groups ADD COLUMN archived_at');
    expect(sql).toContain('ALTER TABLE groups ADD COLUMN max_concurrent_runs');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
    expect(sql).not.toContain('execution_policy');
  });
});

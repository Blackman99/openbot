import { describe, expect, it } from 'vitest';
import {
  COL12_LIMITS_REQUIRES_VERSION,
  TASK_EXECUTION_LIMIT_SCHEMA_STATEMENTS,
} from '../../src/tasks/execution-limit-schema.js';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import { limitGrantCommand } from '../../src/tasks/limit-grant.js';
import { LimitInputError } from '../../src/tasks/execution-limits.js';
import { crossedSoftThreshold, reachedHardLimit } from '../../src/tasks/limit-view.js';

describe('COL-12 execution limit schema', () => {
  const sql = TASK_EXECUTION_LIMIT_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after recovery and admits waiting_budget', () => {
    expect(COL12_LIMITS_REQUIRES_VERSION).toBe('0036_task_execution_limit_snapshots');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0036_task_execution_limit_snapshots');
    expect(sql).toContain('ALTER TABLE workspaces ADD COLUMN execution_policy');
    expect(sql).toContain('ALTER TABLE groups ADD COLUMN execution_policy');
    expect(sql).toContain('CREATE TABLE task_execution_limit_snapshots');
    expect(sql).toContain('CREATE TABLE task_limit_events');
    expect(sql).toContain('CREATE TABLE task_limit_grants');
    expect(sql).toContain("'waiting_budget'");
    expect(sql).toContain('UNIQUE (task_id,actor_user_id,idempotency_key)');
    expect(sql).toContain('max_turns INTEGER NOT NULL CHECK(max_turns>=0 AND max_turns<=100)');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
  });

  it('rejects extra grant keys and non-increasing values before any write', () => {
    expect(() =>
      limitGrantCommand({
        idempotencyKey: 'grant-once',
        dimension: 'turns',
        limit: 2,
        extra: true,
      }),
    ).toThrow(LimitInputError);
    expect(() =>
      limitGrantCommand({ idempotencyKey: 'grant-once', dimension: 'turns', limit: -1 }),
    ).toThrow(LimitInputError);
    expect(
      limitGrantCommand({ idempotencyKey: 'grant-once', dimension: 'turns', limit: 2 }),
    ).toEqual({ idempotencyKey: 'grant-once', dimension: 'turns', limit: 2 });
    expect(crossedSoftThreshold(1, 2)).toBe(true);
    expect(crossedSoftThreshold(2, 2)).toBe(false);
    expect(reachedHardLimit(0, 0)).toBe(true);
    expect(reachedHardLimit(1, 2)).toBe(false);
  });
});

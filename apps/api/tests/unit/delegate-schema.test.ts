import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL14_DELEGATION_REQUIRES_VERSION,
  TASK_DELEGATION_SCHEMA_STATEMENTS,
} from '../../src/tasks/delegate-schema.js';
import { COL14_DELEGATION_POSTGRES_GUARDS } from '../../src/tasks/col14-postgres-guards.js';

describe('COL-14 delegation schema slice', () => {
  const sql = TASK_DELEGATION_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after imported routines and admits waiting_child', () => {
    expect(COL14_DELEGATION_REQUIRES_VERSION).toBe('0040_task_delegation');
    expect(MIGRATION_VERSIONS).toContain('0040_task_delegation');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0051_routines');
    expect(sql).toContain('waiting_child');
    expect(sql).toContain('CREATE TABLE task_delegations');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS tasks_constraint_1');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
  });

  it('recognizes child_result last so COL-12 overlays stay intact', () => {
    const overlay = COL14_DELEGATION_POSTGRES_GUARDS.join('\n');
    expect(overlay).toContain('task_has_child_result_receipt');
    expect(overlay).toContain("origin'='child_result'");
    expect(overlay).toContain('sibling.status NOT IN');
    expect(overlay).toContain('waiting_child');
    expect(overlay).toContain(
      "OLD.status='running' AND NEW.status IN ('completed','failed','cancelled','paused','waiting_child')",
    );
    expect(overlay).toContain(
      "IN ('manual_resume','budget_grant','provider_retry','model_fallback','worker_recovery','child_result')",
    );
    expect(overlay).not.toContain(
      "origin' IN ('provider_retry','model_fallback','worker_recovery','child_result')",
    );
    expect(overlay).not.toContain('INSERT INTO openbot_schema_migrations');
  });
});

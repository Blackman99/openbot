import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  ROUT01_OCCURRENCES_REQUIRES_VERSION,
  ROUT01_ROUTINES_REQUIRES_VERSION,
  ROUTINE_OCCURRENCE_SCHEMA_STATEMENTS,
  ROUTINE_SCHEMA_STATEMENTS,
} from '../../src/routines/schema.js';

describe('ROUT-01 routines schema slice', () => {
  const sql = ROUTINE_SCHEMA_STATEMENTS.join('\n');

  it('is ordered before occurrence uniqueness and stores schedule fields', () => {
    expect(ROUT01_ROUTINES_REQUIRES_VERSION).toBe('0051_routines');
    expect(MIGRATION_VERSIONS).toContain('0050_workspace_event_stream');
    expect(MIGRATION_VERSIONS).toContain('0051_routines');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0052_routine_occurrences');
    expect(sql).toContain('CREATE TABLE routines');
    expect(sql).toContain('owner_user_id');
    expect(sql).toContain('routing_policy');
    expect(sql).toContain('time_zone');
    expect(sql).toContain('execute_at');
    expect(sql).toContain('expires_at');
    expect(sql).toContain('max_cost_micros');
    expect(sql).toContain("kind = 'one_time'");
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('group_imported_routines');
  });
});

describe('ROUT-01 routine occurrence uniqueness', () => {
  const sql = ROUTINE_OCCURRENCE_SCHEMA_STATEMENTS.join('\n');

  it('pins 0052 with a uniqueness constraint on routine occurrence keys', () => {
    expect(ROUT01_OCCURRENCES_REQUIRES_VERSION).toBe('0052_routine_occurrences');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0052_routine_occurrences');
    expect(sql).toContain('CREATE TABLE routine_occurrences');
    expect(sql).toContain('UNIQUE (routine_id, occurrence_key)');
    expect(sql).toContain('task_id');
    expect(sql).toContain('outcome');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
  });
});

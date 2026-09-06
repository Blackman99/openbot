import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  ROUT01_ROUTINES_REQUIRES_VERSION,
  ROUTINE_SCHEMA_STATEMENTS,
} from '../../src/routines/schema.js';

describe('ROUT-01 routines schema slice', () => {
  const sql = ROUTINE_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after workspace event stream and stores schedule fields', () => {
    expect(ROUT01_ROUTINES_REQUIRES_VERSION).toBe('0051_routines');
    expect(MIGRATION_VERSIONS).toContain('0050_workspace_event_stream');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0051_routines');
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

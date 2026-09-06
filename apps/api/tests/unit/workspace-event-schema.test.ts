import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  API06_WORKSPACE_EVENT_STREAM_REQUIRES_VERSION,
  WORKSPACE_EVENT_STREAM_SCHEMA_STATEMENTS,
} from '../../src/events/schema.js';

describe('API-06 workspace event stream schema slice', () => {
  const sql = WORKSPACE_EVENT_STREAM_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after group archive and adds workspace cursor retention', () => {
    expect(API06_WORKSPACE_EVENT_STREAM_REQUIRES_VERSION).toBe('0050_workspace_event_stream');
    expect(MIGRATION_VERSIONS).toContain('0049_group_archive');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0050_workspace_event_stream');
    expect(sql).toContain('CREATE TABLE workspace_event_streams');
    expect(sql).toContain('CREATE TABLE workspace_events');
    expect(sql).toContain('INSERT INTO workspace_event_streams');
    expect(sql).toContain('task.terminal');
    expect(sql).toContain('task.budget_exhausted');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('conversation_delivery');
  });
});

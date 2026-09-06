import { describe, expect, it } from 'vitest';
import {
  COL08_PAUSE_REQUIRES_VERSION,
  TASK_PAUSE_SCHEMA_STATEMENTS,
} from '../../src/tasks/pause-schema.js';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import { pauseCommand } from '../../src/tasks/pause.js';
import { TaskInputError } from '../../src/tasks/errors.js';

describe('COL-08 pause schema first slice', () => {
  const sql = TASK_PAUSE_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after document locators and admits paused status', () => {
    expect(COL08_PAUSE_REQUIRES_VERSION).toBe('0033_task_pause_checkpoints');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0033_task_pause_checkpoints');
    expect(sql).toContain('DROP CONSTRAINT tasks_cancellation_status');
    expect(sql).toContain("'paused'");
    expect(sql).toContain('CREATE TABLE task_pause_commands');
    expect(sql).toContain('CREATE TABLE task_run_pause_checkpoints');
    expect(sql).toContain("strategy='restart_from_task_input_v1'");
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
  });

  it('rejects extra pause command keys before any write', () => {
    expect(() =>
      pauseCommand({
        idempotencyKey: 'pause-once',
        expectedRunId: '11111111-1111-4111-8111-111111111111',
        extra: true,
      }),
    ).toThrow(TaskInputError);
    expect(
      pauseCommand({
        idempotencyKey: 'pause-once',
        expectedRunId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual({
      idempotencyKey: 'pause-once',
      expectedRunId: '11111111-1111-4111-8111-111111111111',
    });
  });
});

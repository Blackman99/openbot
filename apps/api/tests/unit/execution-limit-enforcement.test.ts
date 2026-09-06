import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  evaluateExecutionLimitUsage,
  EXECUTION_LIMIT_SOFT_DENOMINATOR,
  EXECUTION_LIMIT_SOFT_NUMERATOR,
  remainingDurationMs,
} from '../../src/tasks/execution-limit-enforcement.js';
import {
  COL12_ENFORCEMENT_REQUIRES_VERSION,
  TASK_EXECUTION_LIMIT_ENFORCEMENT_SCHEMA_STATEMENTS,
} from '../../src/tasks/execution-limit-enforcement-schema.js';
import { COL12_ENFORCEMENT_POSTGRES_GUARDS } from '../../src/tasks/col12-postgres-guards.js';

describe('COL-12 soft threshold and hard limit evaluation', () => {
  const snapshot = {
    duration: { maxDurationMs: 1_000, source: 'workspace' as const },
    turns: { maxTurns: 8, source: 'group' as const },
    delegationDepth: { maxDelegationDepth: 2, source: 'task' as const },
    handoffs: { maxHandoffs: 5, source: 'workspace' as const },
  };

  it('uses four fifths of each snapshotted hard limit as the visible warning threshold', () => {
    expect(EXECUTION_LIMIT_SOFT_NUMERATOR).toBe(4);
    expect(EXECUTION_LIMIT_SOFT_DENOMINATOR).toBe(5);
    expect(
      evaluateExecutionLimitUsage(snapshot, {
        durationMs: 799,
        turns: 6,
        delegationDepth: 1,
        handoffs: 3,
      }),
    ).toEqual([]);
    expect(
      evaluateExecutionLimitUsage(snapshot, {
        durationMs: 800,
        turns: 7,
        delegationDepth: 2,
        handoffs: 4,
      }),
    ).toEqual([
      {
        dimension: 'duration',
        used: 800,
        limit: 1_000,
        source: 'workspace',
        soft: true,
        hard: false,
      },
      { dimension: 'turns', used: 7, limit: 8, source: 'group', soft: true, hard: false },
      {
        dimension: 'delegationDepth',
        used: 2,
        limit: 2,
        source: 'task',
        soft: true,
        hard: false,
      },
      { dimension: 'handoffs', used: 4, limit: 5, source: 'workspace', soft: true, hard: false },
    ]);
  });

  it('marks a hard limit when another Run would exceed the snapshotted cap', () => {
    expect(
      evaluateExecutionLimitUsage(snapshot, {
        durationMs: 1_000,
        turns: 8,
        delegationDepth: 3,
        handoffs: 5,
      }),
    ).toEqual([
      {
        dimension: 'duration',
        used: 1_000,
        limit: 1_000,
        source: 'workspace',
        soft: true,
        hard: true,
      },
      { dimension: 'turns', used: 8, limit: 8, source: 'group', soft: true, hard: true },
      {
        dimension: 'delegationDepth',
        used: 3,
        limit: 2,
        source: 'task',
        soft: true,
        hard: true,
      },
      { dimension: 'handoffs', used: 5, limit: 5, source: 'workspace', soft: true, hard: true },
    ]);
  });

  it('still warns when a one-unit cap crosses soft and hard together', () => {
    expect(
      evaluateExecutionLimitUsage(
        { turns: { maxTurns: 1, source: 'task' } },
        { durationMs: 0, turns: 1, delegationDepth: 0, handoffs: 0 },
      ),
    ).toEqual([{ dimension: 'turns', used: 1, limit: 1, source: 'task', soft: true, hard: true }]);
    expect(
      evaluateExecutionLimitUsage(
        { delegationDepth: { maxDelegationDepth: 0, source: 'run' } },
        { durationMs: 0, turns: 0, delegationDepth: 0, handoffs: 0 },
      ),
    ).toEqual([]);
    expect(remainingDurationMs(1_000, 0)).toBe(1_000);
    expect(remainingDurationMs(1_000, 400)).toBe(600);
    expect(remainingDurationMs(1_000, 1_000)).toBe(0);
    expect(remainingDurationMs(1_000, 1_200)).toBe(0);
  });
});

describe('COL-12 enforcement schema slice', () => {
  const sql = TASK_EXECUTION_LIMIT_ENFORCEMENT_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after snapshots and admits waiting_budget plus warning events', () => {
    expect(COL12_ENFORCEMENT_REQUIRES_VERSION).toBe('0037_task_execution_limit_enforcement');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0037_task_execution_limit_enforcement');
    expect(sql).toContain('waiting_budget');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS tasks_constraint_1');
    expect(sql).toContain('CREATE TABLE task_execution_limit_warnings');
    expect(sql).toContain("event_type='task.limit.warning'");
    expect(sql).not.toContain('delivery_limit_event_type');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
  });

  it('relaxes Task/Run homology for waiting_budget in a repeatable overlay', () => {
    const overlay = COL12_ENFORCEMENT_POSTGRES_GUARDS.join('\n');
    expect(overlay).toContain("NEW.status<>'waiting_budget'");
    expect(overlay).toContain(
      "NEW.status IN ('running','failed','cancelled','paused','waiting_budget')",
    );
    expect(overlay).toContain("parent.status<>'waiting_budget'");
    expect(overlay).toContain("'task.limit.warning'");
    expect(overlay).not.toContain('INSERT INTO openbot_schema_migrations');
  });
});

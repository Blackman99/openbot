import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import { TaskInputError } from '../../src/tasks/errors.js';
import { limitGrantCommand, planBudgetGrant } from '../../src/tasks/execution-limit-grant.js';
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
    expect(MIGRATION_VERSIONS).toContain('0037_task_execution_limit_enforcement');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0048_task_cost_grants');
    expect(sql).toContain('waiting_budget');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS tasks_constraint_1');
    expect(sql).toContain('CREATE TABLE task_execution_limit_warnings');
    expect(sql).toContain('CREATE TABLE task_execution_limit_grants');
    expect(sql).toContain('UNIQUE (task_id,actor_user_id,idempotency_key)');
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
    expect(overlay).toContain('task_has_budget_grant_receipt');
    expect(overlay).toContain("OLD.status='waiting_budget' AND NEW.status='queued'");
    expect(overlay).toContain(
      "status IN ('paused','waiting_budget') AND NOT (allow_paused AND id=target)",
    );
    expect(overlay).toContain(
      'EXISTS (SELECT 1 FROM task_execution_limit_grants g WHERE g.task_id=NEW.id)',
    );
    expect(overlay).toContain('CREATE OR REPLACE FUNCTION protect_task_run()');
    expect(overlay).toContain(
      "parent.status='waiting_budget' AND latest.status IN ('failed','paused')",
    );
    expect(overlay).not.toContain('INSERT INTO openbot_schema_migrations');
  });
});

describe('COL-12 authorized limit grant command', () => {
  const now = new Date('2026-09-06T05:00:00.000Z');
  const binding = {
    scope: { kind: 'personal' as const, id: '11111111-1111-4111-8111-111111111111' },
    connectionId: '22222222-2222-4222-8222-222222222222',
    modelId: 'task-model',
  };

  it('accepts an integer raise of one selected dimension', () => {
    expect(
      limitGrantCommand({
        idempotencyKey: 'grant-1',
        dimension: 'duration',
        limit: 5000,
      }),
    ).toEqual({
      idempotencyKey: 'grant-1',
      dimension: 'duration',
      limit: 5000,
    });
    expect(
      limitGrantCommand({
        idempotencyKey: 'grant-cost',
        dimension: 'cost',
        limit: 1_000_000,
      }),
    ).toEqual({
      idempotencyKey: 'grant-cost',
      dimension: 'cost',
      limit: 1_000_000,
    });
  });

  it('rejects unknown keys, non-integers, and out-of-range limits', () => {
    expect(() =>
      limitGrantCommand({
        idempotencyKey: 'grant-1',
        dimension: 'turns',
        limit: 2,
        extra: true,
      }),
    ).toThrow(TaskInputError);
    expect(() =>
      limitGrantCommand({
        idempotencyKey: 'grant-1',
        dimension: 'duration',
        limit: 1.5,
      }),
    ).toThrow(TaskInputError);
    expect(() =>
      limitGrantCommand({
        idempotencyKey: 'grant-1',
        dimension: 'duration',
        limit: 0,
      }),
    ).toThrow(TaskInputError);
  });

  it('feeds the shared next-attempt writer without rewriting usage', () => {
    expect(
      planBudgetGrant({
        binding,
        sourceRunId: '33333333-3333-4333-8333-333333333333',
        chainRootRunId: '33333333-3333-4333-8333-333333333333',
        chainAttemptOrdinal: 2,
        chainLimitSnapshot: 4,
        now,
      }),
    ).toEqual({
      origin: 'budget_grant',
      reason: 'budget_grant',
      binding,
      previousBinding: binding,
      notBefore: now,
      delayMs: 0,
      jitterMs: 0,
      chainRootRunId: '33333333-3333-4333-8333-333333333333',
      previousRunId: '33333333-3333-4333-8333-333333333333',
      chainAttemptOrdinal: 2,
      chainLimitSnapshot: 4,
      modelAttemptOrdinal: 1,
    });
  });

  it('replays a grant successor without selecting audit_events as runtime', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/tasks/execution-limit-grant.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('readQueuedAuditMetadataForTask');
    expect(source).not.toContain('FROM audit_events');
  });
});

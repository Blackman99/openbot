import { describe, expect, it } from 'vitest';
import type { SqlConnection } from '../../src/auth/postgres-auth-repository.js';
import {
  applyRunTokenReservation,
  reconcileRunTokenReservation,
  tokenBudgetScopes,
} from '../../src/tasks/token-budget-store.js';
import { reservationRequestForRun } from '../../src/tasks/token-budget.js';

type Ledger = {
  used_input_tokens: number;
  used_output_tokens: number;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
};

function memoryConnection() {
  const ledgers = new Map<string, Ledger>();
  const reservations = new Map<string, { input_tokens: number; output_tokens: number }>();
  const connection = {
    release() {},
    async query(statement: string, parameters: unknown[] = []) {
      const sql = statement.replace(/\s+/g, ' ');
      if (sql.includes('INSERT INTO task_token_ledgers')) {
        const key = `${parameters[0]}:${parameters[1]}`;
        if (!ledgers.has(key))
          ledgers.set(key, {
            used_input_tokens: 0,
            used_output_tokens: 0,
            reserved_input_tokens: 0,
            reserved_output_tokens: 0,
          });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM task_token_ledgers')) {
        const key = `${parameters[0]}:${parameters[1]}`;
        const row = ledgers.get(key);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('SET reserved_input_tokens=reserved_input_tokens+$3')) {
        const key = `${parameters[0]}:${parameters[1]}`;
        const row = ledgers.get(key)!;
        row.reserved_input_tokens += Number(parameters[2]);
        row.reserved_output_tokens += Number(parameters[3]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO task_token_reservations')) {
        reservations.set(String(parameters[0]), {
          input_tokens: Number(parameters[1]),
          output_tokens: Number(parameters[2]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM task_token_reservations')) {
        reservations.delete(String(parameters[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM task_token_reservations')) {
        const row = reservations.get(String(parameters[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('used_input_tokens=used_input_tokens+$5')) {
        const key = `${parameters[0]}:${parameters[1]}`;
        const row = ledgers.get(key);
        if (!row) return { rows: [], rowCount: 0 };
        row.reserved_input_tokens -= Number(parameters[2]);
        row.reserved_output_tokens -= Number(parameters[3]);
        row.used_input_tokens += Number(parameters[4]);
        row.used_output_tokens += Number(parameters[5]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL ${sql}`);
    },
  } as SqlConnection;
  return { connection, ledgers, reservations };
}

const target = {
  runId: '11111111-1111-1111-1111-111111111111',
  taskId: '22222222-2222-2222-2222-222222222222',
  workspaceId: '33333333-3333-3333-3333-333333333333',
  groupId: '44444444-4444-4444-4444-444444444444',
};
const now = new Date('2026-09-06T05:00:00.000Z');

describe('COL-17 token ledger reservation', () => {
  it('reserves the request at every applicable scope before a second Run can race the cap', async () => {
    expect(tokenBudgetScopes(target).map((scope) => scope.kind)).toEqual([
      'workspace',
      'group',
      'task',
      'run',
    ]);
    expect(reservationRequestForRun(50, 12)).toEqual({ inputTokens: 12, outputTokens: 38 });
    expect(reservationRequestForRun(50, 80)).toEqual({ inputTokens: 50, outputTokens: 0 });
    const { connection, ledgers, reservations } = memoryConnection();
    const budgets = {
      workspace: { maxTotalTokens: 80 },
      group: { maxTotalTokens: 60 },
      task: { maxTotalTokens: 50 },
      run: { maxTotalTokens: 50 },
    };
    const request = { inputTokens: 10, outputTokens: 5 };
    await expect(
      applyRunTokenReservation(connection, target, budgets, request, now),
    ).resolves.toMatchObject({ allowed: true, hard: false });
    expect(reservations.get(target.runId)).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(ledgers.get(`workspace:${target.workspaceId}`)).toMatchObject({
      reserved_input_tokens: 10,
      reserved_output_tokens: 5,
    });
    const raced = await applyRunTokenReservation(
      connection,
      { ...target, runId: '55555555-5555-5555-5555-555555555555' },
      budgets,
      { inputTokens: 40, outputTokens: 10 },
      now,
    );
    expect(raced).toMatchObject({ allowed: false, hard: true, blocked: { kind: 'group' } });
    expect(ledgers.get(`group:${target.groupId}`)).toMatchObject({
      reserved_input_tokens: 10,
      reserved_output_tokens: 5,
    });
  });

  it('reconciles reserved tokens to recorded usage on finish or abort', async () => {
    const { connection, ledgers, reservations } = memoryConnection();
    await applyRunTokenReservation(
      connection,
      target,
      { task: { maxTotalTokens: 50 } },
      { inputTokens: 8, outputTokens: 7 },
      now,
    );
    await reconcileRunTokenReservation(connection, target, { inputTokens: 6, outputTokens: 4 });
    expect(reservations.has(target.runId)).toBe(false);
    expect(ledgers.get(`task:${target.taskId}`)).toEqual({
      used_input_tokens: 6,
      used_output_tokens: 4,
      reserved_input_tokens: 0,
      reserved_output_tokens: 0,
    });
    await reconcileRunTokenReservation(connection, target, { inputTokens: 1, outputTokens: 1 });
    expect(ledgers.get(`task:${target.taskId}`)).toEqual({
      used_input_tokens: 6,
      used_output_tokens: 4,
      reserved_input_tokens: 0,
      reserved_output_tokens: 0,
    });
  });
});

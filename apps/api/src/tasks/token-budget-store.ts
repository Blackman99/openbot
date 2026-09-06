import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import {
  evaluateScopedTokenReservation,
  projectTokenBudgetScope,
  type TokenBudget,
  type TokenBudgetLayer,
  type TokenBudgetScopeView,
  type TokenCounts,
} from './token-budget.js';

export type TokenBudgetTarget = {
  runId: string;
  taskId: string;
  workspaceId: string;
  groupId: string | null;
};

export const ENSURE_TOKEN_LEDGER_SQL = `INSERT INTO task_token_ledgers(scope_kind, scope_id)
VALUES($1,$2) ON CONFLICT (scope_kind, scope_id) DO NOTHING`;

export const LOCK_TOKEN_LEDGER_SQL = `SELECT used_input_tokens,used_output_tokens,reserved_input_tokens,reserved_output_tokens
FROM task_token_ledgers WHERE scope_kind=$1 AND scope_id=$2 FOR UPDATE`;

export const RESERVE_TOKEN_LEDGER_SQL = `UPDATE task_token_ledgers
SET reserved_input_tokens=reserved_input_tokens+$3,reserved_output_tokens=reserved_output_tokens+$4
WHERE scope_kind=$1 AND scope_id=$2`;

export const INSERT_TOKEN_RESERVATION_SQL = `INSERT INTO task_token_reservations(run_id,input_tokens,output_tokens,created_at)
VALUES($1,$2,$3,$4)`;

export const READ_TOKEN_RESERVATION_SQL = `SELECT input_tokens,output_tokens FROM task_token_reservations WHERE run_id=$1 FOR UPDATE`;

export const RECONCILE_TOKEN_LEDGER_SQL = `UPDATE task_token_ledgers
SET reserved_input_tokens=reserved_input_tokens-$3,reserved_output_tokens=reserved_output_tokens-$4,
    used_input_tokens=used_input_tokens+$5,used_output_tokens=used_output_tokens+$6
WHERE scope_kind=$1 AND scope_id=$2`;

export const DELETE_TOKEN_RESERVATION_SQL = `DELETE FROM task_token_reservations WHERE run_id=$1`;

export const READ_TOKEN_LEDGER_SQL = `SELECT used_input_tokens,used_output_tokens,reserved_input_tokens,reserved_output_tokens
FROM task_token_ledgers WHERE scope_kind=$1 AND scope_id=$2`;

const EMPTY_LEDGER = {
  used: { inputTokens: 0, outputTokens: 0 },
  reserved: { inputTokens: 0, outputTokens: 0 },
};

export function tokenBudgetScopes(target: TokenBudgetTarget): Array<{
  kind: TokenBudgetLayer;
  id: string;
}> {
  const scopes: Array<{ kind: TokenBudgetLayer; id: string }> = [
    { kind: 'workspace', id: target.workspaceId },
  ];
  if (target.groupId) scopes.push({ kind: 'group', id: target.groupId });
  scopes.push({ kind: 'task', id: target.taskId }, { kind: 'run', id: target.runId });
  return scopes;
}

function counts(row: {
  used_input_tokens: string | number;
  used_output_tokens: string | number;
  reserved_input_tokens: string | number;
  reserved_output_tokens: string | number;
}) {
  return {
    used: {
      inputTokens: Number(row.used_input_tokens),
      outputTokens: Number(row.used_output_tokens),
    },
    reserved: {
      inputTokens: Number(row.reserved_input_tokens),
      outputTokens: Number(row.reserved_output_tokens),
    },
  };
}

export async function readTokenBudgetView(
  connection: SqlConnection,
  target: TokenBudgetTarget,
  budgets: Partial<Record<TokenBudgetLayer, TokenBudget>>,
): Promise<TokenBudgetScopeView[]> {
  const views: TokenBudgetScopeView[] = [];
  for (const scope of tokenBudgetScopes(target).filter((item) => budgets[item.kind])) {
    const row = (
      await connection.query<{
        used_input_tokens: string | number;
        used_output_tokens: string | number;
        reserved_input_tokens: string | number;
        reserved_output_tokens: string | number;
      }>(READ_TOKEN_LEDGER_SQL, [scope.kind, scope.id])
    ).rows[0];
    views.push(
      projectTokenBudgetScope(scope.kind, budgets[scope.kind]!, row ? counts(row) : EMPTY_LEDGER),
    );
  }
  return views;
}

export async function applyRunTokenReservation(
  connection: SqlConnection,
  target: TokenBudgetTarget,
  budgets: Partial<Record<TokenBudgetLayer, TokenBudget>>,
  request: TokenCounts,
  now: Date,
): Promise<ReturnType<typeof evaluateScopedTokenReservation>> {
  const existing = (
    await connection.query<{ input_tokens: string | number; output_tokens: string | number }>(
      'SELECT input_tokens,output_tokens FROM task_token_reservations WHERE run_id=$1',
      [target.runId],
    )
  ).rows[0];
  if (existing)
    return {
      allowed: true,
      hard: false,
      soft: false,
      warnings: [],
    };
  const scopes = tokenBudgetScopes(target).filter((scope) => budgets[scope.kind]);
  const loaded = [];
  for (const scope of scopes) {
    await connection.query(ENSURE_TOKEN_LEDGER_SQL, [scope.kind, scope.id]);
    const row = (
      await connection.query<{
        used_input_tokens: string | number;
        used_output_tokens: string | number;
        reserved_input_tokens: string | number;
        reserved_output_tokens: string | number;
      }>(LOCK_TOKEN_LEDGER_SQL, [scope.kind, scope.id])
    ).rows[0];
    if (!row) continue;
    loaded.push({ kind: scope.kind, budget: budgets[scope.kind]!, ...counts(row) });
  }
  const decision = evaluateScopedTokenReservation({ request, scopes: loaded });
  if (!decision.allowed) return decision;
  for (const scope of scopes)
    await connection.query(RESERVE_TOKEN_LEDGER_SQL, [
      scope.kind,
      scope.id,
      request.inputTokens,
      request.outputTokens,
    ]);
  if (scopes.length)
    await connection.query(INSERT_TOKEN_RESERVATION_SQL, [
      target.runId,
      request.inputTokens,
      request.outputTokens,
      now,
    ]);
  return decision;
}

export async function reconcileRunTokenReservation(
  connection: SqlConnection,
  target: TokenBudgetTarget,
  usage: TokenCounts,
) {
  const reserved = (
    await connection.query<{ input_tokens: string | number; output_tokens: string | number }>(
      READ_TOKEN_RESERVATION_SQL,
      [target.runId],
    )
  ).rows[0];
  if (!reserved) return;
  const request = {
    inputTokens: Number(reserved.input_tokens),
    outputTokens: Number(reserved.output_tokens),
  };
  for (const scope of tokenBudgetScopes(target)) {
    const row = (await connection.query(LOCK_TOKEN_LEDGER_SQL, [scope.kind, scope.id])).rows[0];
    if (!row) continue;
    await connection.query(RECONCILE_TOKEN_LEDGER_SQL, [
      scope.kind,
      scope.id,
      request.inputTokens,
      request.outputTokens,
      usage.inputTokens,
      usage.outputTokens,
    ]);
  }
  await connection.query(DELETE_TOKEN_RESERVATION_SQL, [target.runId]);
}

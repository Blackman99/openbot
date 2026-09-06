import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import {
  evaluateScopedCostReservation,
  overlayCostGrant,
  projectCostBudgetScope,
  resolveCostBudgets,
  type CostBudget,
  type CostBudgetLayer,
  type CostBudgetScopeView,
} from './cost-budget.js';
import { loadExecutionLimitPolicies, parseExecutionPolicy } from './execution-limits.js';

export type CostBudgetTarget = {
  runId: string;
  taskId: string;
  workspaceId: string;
  groupId: string | null;
};

export const ENSURE_COST_LEDGER_SQL = `INSERT INTO task_cost_ledgers(scope_kind, scope_id)
VALUES($1,$2) ON CONFLICT (scope_kind, scope_id) DO NOTHING`;

export const LOCK_COST_LEDGER_SQL = `SELECT used_micros,reserved_micros
FROM task_cost_ledgers WHERE scope_kind=$1 AND scope_id=$2 FOR UPDATE`;

export const RESERVE_COST_LEDGER_SQL = `UPDATE task_cost_ledgers
SET reserved_micros=reserved_micros+$3
WHERE scope_kind=$1 AND scope_id=$2`;

export const INSERT_COST_RESERVATION_SQL = `INSERT INTO task_cost_reservations(run_id,micros,price_version_id,created_at)
VALUES($1,$2,$3,$4)`;

export const TAKE_COST_RESERVATION_SQL = `DELETE FROM task_cost_reservations WHERE run_id=$1 RETURNING micros`;

export const RECONCILE_COST_LEDGER_SQL = `UPDATE task_cost_ledgers
SET reserved_micros=reserved_micros-$3,used_micros=used_micros+$4
WHERE scope_kind=$1 AND scope_id=$2`;

export const READ_COST_LEDGER_SQL = `SELECT used_micros,reserved_micros
FROM task_cost_ledgers WHERE scope_kind=$1 AND scope_id=$2`;

const EMPTY_LEDGER = { usedMicros: 0, reservedMicros: 0 };

export function costBudgetScopes(target: CostBudgetTarget): Array<{
  kind: CostBudgetLayer;
  id: string;
}> {
  const scopes: Array<{ kind: CostBudgetLayer; id: string }> = [
    { kind: 'workspace', id: target.workspaceId },
  ];
  if (target.groupId) scopes.push({ kind: 'group', id: target.groupId });
  scopes.push({ kind: 'task', id: target.taskId });
  return scopes;
}

function amounts(row: { used_micros: string | number; reserved_micros: string | number }) {
  return { usedMicros: Number(row.used_micros), reservedMicros: Number(row.reserved_micros) };
}

export async function loadGrantedCostLimit(
  connection: SqlConnection,
  taskId: string,
): Promise<number | undefined> {
  const row = (
    await connection.query<{ granted_limit: string | number }>(
      `SELECT granted_limit FROM task_execution_limit_grants
       WHERE task_id=$1 AND dimension='cost'
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [taskId],
    )
  ).rows[0];
  return row ? Number(row.granted_limit) : undefined;
}

export async function loadResolvedCostBudgets(
  connection: SqlConnection,
  target: { taskId: string; workspaceId: string; groupId: string | null },
): Promise<Partial<Record<CostBudgetLayer, CostBudget>>> {
  const layers = await loadExecutionLimitPolicies(connection, target.workspaceId, target.groupId);
  const taskPolicy = (
    await connection.query<{ execution_policy: unknown }>(
      'SELECT execution_policy FROM tasks WHERE id=$1',
      [target.taskId],
    )
  ).rows[0];
  return overlayCostGrant(
    resolveCostBudgets({
      workspace: layers.workspace,
      group: layers.group,
      task: parseExecutionPolicy(taskPolicy?.execution_policy),
    }),
    await loadGrantedCostLimit(connection, target.taskId),
  );
}

export async function readCostBudgetView(
  connection: SqlConnection,
  target: CostBudgetTarget,
  budgets: Partial<Record<CostBudgetLayer, CostBudget>>,
): Promise<CostBudgetScopeView[]> {
  const views: CostBudgetScopeView[] = [];
  for (const scope of costBudgetScopes(target).filter((item) => budgets[item.kind])) {
    const row = (
      await connection.query<{ used_micros: string | number; reserved_micros: string | number }>(
        READ_COST_LEDGER_SQL,
        [scope.kind, scope.id],
      )
    ).rows[0];
    views.push(
      projectCostBudgetScope(scope.kind, budgets[scope.kind]!, row ? amounts(row) : EMPTY_LEDGER),
    );
  }
  return views;
}

export async function applyRunCostReservation(
  connection: SqlConnection,
  target: CostBudgetTarget,
  budgets: Partial<Record<CostBudgetLayer, CostBudget>>,
  request: { micros: number; priceVersionId: string },
  now: Date,
): Promise<ReturnType<typeof evaluateScopedCostReservation>> {
  const existing = (
    await connection.query<{ micros: string | number }>(
      'SELECT micros FROM task_cost_reservations WHERE run_id=$1',
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
  const scopes = costBudgetScopes(target).filter((scope) => budgets[scope.kind]);
  const loaded = [];
  for (const scope of scopes) {
    await connection.query(ENSURE_COST_LEDGER_SQL, [scope.kind, scope.id]);
    const row = (
      await connection.query<{ used_micros: string | number; reserved_micros: string | number }>(
        LOCK_COST_LEDGER_SQL,
        [scope.kind, scope.id],
      )
    ).rows[0];
    if (!row) continue;
    loaded.push({ kind: scope.kind, budget: budgets[scope.kind]!, ...amounts(row) });
  }
  const decision = evaluateScopedCostReservation({
    requestMicros: request.micros,
    scopes: loaded,
  });
  if (!decision.allowed) return decision;
  for (const scope of scopes)
    await connection.query(RESERVE_COST_LEDGER_SQL, [scope.kind, scope.id, request.micros]);
  if (scopes.length)
    await connection.query(INSERT_COST_RESERVATION_SQL, [
      target.runId,
      request.micros,
      request.priceVersionId,
      now,
    ]);
  return decision;
}

export async function reconcileRunCostReservation(
  connection: SqlConnection,
  target: CostBudgetTarget,
  usageMicros: number,
) {
  const reserved = (
    await connection.query<{ micros: string | number }>(TAKE_COST_RESERVATION_SQL, [target.runId])
  ).rows[0];
  if (!reserved) return;
  const requestMicros = Number(reserved.micros);
  for (const scope of costBudgetScopes(target)) {
    const row = (await connection.query(LOCK_COST_LEDGER_SQL, [scope.kind, scope.id])).rows[0];
    if (!row) continue;
    await connection.query(RECONCILE_COST_LEDGER_SQL, [
      scope.kind,
      scope.id,
      requestMicros,
      usageMicros,
    ]);
  }
}

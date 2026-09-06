// Migration 0046 follows 0045. Published 0017–0045 statement lists stay
// unchanged. Ledgers hold used plus reserved micros at lifetime scopes.
// One Run reservation is deleted on finish or abort.
export const TASK_COST_BUDGET_SCHEMA_STATEMENTS = [
  `CREATE TABLE task_cost_ledgers (
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace','group','task')),
    scope_id UUID NOT NULL,
    used_micros BIGINT NOT NULL DEFAULT 0 CHECK(used_micros>=0),
    reserved_micros BIGINT NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
    PRIMARY KEY (scope_kind, scope_id)
  )`,
  `CREATE TABLE task_cost_reservations (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    micros BIGINT NOT NULL CHECK(micros>=0),
    price_version_id UUID NOT NULL REFERENCES model_price_versions(id),
    created_at TIMESTAMPTZ NOT NULL
  )`,
] as const;

export const COL18_COST_BUDGET_REQUIRES_VERSION = '0046_task_cost_budgets';

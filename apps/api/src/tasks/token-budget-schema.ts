// Migration 0042 follows 0041. Published 0017/0022/0023/0033/0034/0035/0036/0037/0038/0039/0040/0041
// statement lists stay unchanged. Ledgers hold used plus reserved tokens at
// every applicable scope. One Run reservation is settled on finish or abort.
export const TASK_TOKEN_BUDGET_SCHEMA_STATEMENTS = [
  `CREATE TABLE task_token_ledgers (
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace','group','task','run')),
    scope_id UUID NOT NULL,
    used_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK(used_input_tokens>=0),
    used_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK(used_output_tokens>=0),
    reserved_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK(reserved_input_tokens>=0),
    reserved_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK(reserved_output_tokens>=0),
    PRIMARY KEY (scope_kind, scope_id)
  )`,
  `CREATE TABLE task_token_reservations (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    input_tokens BIGINT NOT NULL CHECK(input_tokens>=0),
    output_tokens BIGINT NOT NULL CHECK(output_tokens>=0),
    created_at TIMESTAMPTZ NOT NULL
  )`,
] as const;

export const COL17_TOKEN_BUDGET_REQUIRES_VERSION = '0042_task_token_budgets';

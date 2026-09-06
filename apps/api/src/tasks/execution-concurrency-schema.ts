// Migration 0038 follows 0037. Published 0017/0022/0023/0033/0034/0035/0036/0037
// statement lists stay unchanged. Concurrency holds are live scheduling state,
// not COL-12 budget snapshots.
export const TASK_RUN_CONCURRENCY_SCHEMA_STATEMENTS = [
  "ALTER TABLE tasks ADD COLUMN execution_policy JSONB NOT NULL DEFAULT '{}'::jsonb",
  `CREATE TABLE task_run_concurrency_holds (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    layer TEXT NOT NULL CHECK (layer IN ('workspace','group','task')),
    max_concurrent_runs INTEGER NOT NULL CHECK (max_concurrent_runs>=1),
    used INTEGER NOT NULL CHECK (used>=0),
    created_at TIMESTAMPTZ NOT NULL
  )`,
] as const;

export const COL13_CONCURRENCY_REQUIRES_VERSION = '0038_task_run_concurrency_holds';

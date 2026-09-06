// Migration 0036 follows 0035. Published 0017/0022/0023/0033/0034/0035
// statement lists stay unchanged. Workspace and Group policies are per-root
// templates copied onto each Task; they are not shared daily quotas.
export const TASK_EXECUTION_LIMIT_SCHEMA_STATEMENTS = [
  "ALTER TABLE workspaces ADD COLUMN execution_policy JSONB NOT NULL DEFAULT '{}'::jsonb",
  "ALTER TABLE groups ADD COLUMN execution_policy JSONB NOT NULL DEFAULT '{}'::jsonb",
  `CREATE TABLE task_execution_limit_snapshots (
    task_id UUID PRIMARY KEY REFERENCES tasks(id),
    max_duration_ms BIGINT NOT NULL CHECK(max_duration_ms>0 AND max_duration_ms<=9007199254740991),
    duration_source TEXT NOT NULL CHECK(duration_source IN ('workspace','group','task','run')),
    max_turns INTEGER NOT NULL CHECK(max_turns>0),
    turns_source TEXT NOT NULL CHECK(turns_source IN ('workspace','group','task','run')),
    max_delegation_depth INTEGER NOT NULL CHECK(max_delegation_depth>=0),
    delegation_depth_source TEXT NOT NULL CHECK(delegation_depth_source IN ('workspace','group','task','run')),
    max_handoffs INTEGER CHECK(max_handoffs IS NULL OR max_handoffs>=0),
    handoffs_source TEXT CHECK(
      (max_handoffs IS NULL AND handoffs_source IS NULL)
      OR (max_handoffs IS NOT NULL AND handoffs_source IN ('workspace','group','task','run'))
    ),
    created_at TIMESTAMPTZ NOT NULL
  )`,
] as const;

export const COL12_LIMITS_REQUIRES_VERSION = '0036_task_execution_limit_snapshots';

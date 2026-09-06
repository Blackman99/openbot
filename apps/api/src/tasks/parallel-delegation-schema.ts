// Migration 0043 follows 0042. One parent Run may record many children.
// Grant and token ledgers stay unchanged.

export const TASK_PARALLEL_DELEGATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE task_delegations_parallel (
    parent_run_id UUID NOT NULL REFERENCES task_runs(id),
    parent_task_id UUID NOT NULL REFERENCES tasks(id),
    child_task_id UUID NOT NULL UNIQUE REFERENCES tasks(id),
    action_id VARCHAR(128) NOT NULL CHECK(action_id<>''),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (parent_run_id, child_task_id),
    UNIQUE (parent_run_id, action_id)
  )`,
  'INSERT INTO task_delegations_parallel SELECT parent_run_id,parent_task_id,child_task_id,action_id,created_at FROM task_delegations',
  'DROP TABLE task_delegations',
  'ALTER TABLE task_delegations_parallel RENAME TO task_delegations',
] as const;

export const COL15_PARALLEL_DELEGATION_REQUIRES_VERSION = '0043_task_parallel_delegations';

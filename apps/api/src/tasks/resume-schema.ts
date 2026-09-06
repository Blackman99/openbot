// Migration 0034 follows 0033. Published 0022/0023 statement lists stay
// unchanged; resume consumes the single COL-10 next-attempt writer.
export const TASK_RESUME_SCHEMA_STATEMENTS = [
  `CREATE TABLE task_resume_commands (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    actor_user_id UUID NOT NULL REFERENCES users(id),
    idempotency_key VARCHAR(128) NOT NULL CHECK(idempotency_key<>''),
    expected_run_id UUID NOT NULL REFERENCES task_runs(id),
    run_id UUID NOT NULL REFERENCES task_runs(id),
    attempt INTEGER NOT NULL CHECK(attempt>1),
    checkpoint_id UUID NOT NULL REFERENCES task_run_pause_checkpoints(id),
    resumed_at TIMESTAMPTZ NOT NULL,
    affected_task_count INTEGER NOT NULL CHECK(affected_task_count>=0),
    affected_run_count INTEGER NOT NULL CHECK(affected_run_count=affected_task_count),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(task_id,actor_user_id,idempotency_key),
    CHECK(expected_run_id<>run_id)
  )`,
] as const;

export const COL08_RESUME_REQUIRES_VERSION = '0034_task_resume_commands';

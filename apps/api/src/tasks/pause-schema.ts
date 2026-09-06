// Migration 0033 follows 0032. Published 0022/0023 statement lists stay
// unchanged; this ledger only replaces the named cancellation status checks.
export const TASK_PAUSE_SCHEMA_STATEMENTS = [
  'ALTER TABLE tasks DROP CONSTRAINT tasks_cancellation_status',
  'ALTER TABLE task_runs DROP CONSTRAINT task_runs_cancellation_status',
  'ALTER TABLE task_runs DROP CONSTRAINT task_runs_cancellation_fields',
  'ALTER TABLE conversation_delivery_events DROP CONSTRAINT delivery_cancellation_status',
  'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT delivery_receipt_cancellation_status',
  "ALTER TABLE tasks ADD CONSTRAINT tasks_pause_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused'))",
  "ALTER TABLE task_runs ADD CONSTRAINT task_runs_pause_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused'))",
  `ALTER TABLE task_runs ADD CONSTRAINT task_runs_pause_fields CHECK (
    (status='queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
    OR (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
    OR (status='completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL AND output_event_id IS NOT NULL)
    OR (status='failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND output_event_id IS NULL)
    OR (status='cancelled' AND finished_at IS NOT NULL AND finished_at>=created_at AND (started_at IS NULL OR finished_at>=started_at)
      AND error_code IS NULL AND output_event_id IS NULL AND (started_at IS NOT NULL OR input_tokens IS NULL))
    OR (status='paused' AND finished_at IS NOT NULL AND finished_at>=created_at AND (started_at IS NULL OR finished_at>=started_at)
      AND error_code IS NULL AND output_event_id IS NULL AND (started_at IS NOT NULL OR input_tokens IS NULL))
  )`,
  "ALTER TABLE conversation_delivery_events ADD CONSTRAINT delivery_pause_status CHECK(run_status IS NULL OR run_status IN ('queued','running','completed','failed','cancelled','paused'))",
  "ALTER TABLE task_run_delivery_receipts ADD CONSTRAINT delivery_receipt_pause_status CHECK(run_status IN ('queued','running','completed','failed','cancelled','paused'))",
  `CREATE TABLE task_pause_commands (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    root_task_id UUID NOT NULL REFERENCES tasks(id),
    actor_user_id UUID NOT NULL REFERENCES users(id),
    idempotency_key VARCHAR(128) NOT NULL CHECK(idempotency_key<>''),
    expected_run_id UUID NOT NULL REFERENCES task_runs(id),
    attempt INTEGER NOT NULL CHECK(attempt>0),
    paused_at TIMESTAMPTZ NOT NULL,
    affected_task_count INTEGER NOT NULL CHECK(affected_task_count>=0),
    affected_run_count INTEGER NOT NULL CHECK(affected_run_count=affected_task_count),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(task_id,actor_user_id,idempotency_key)
  )`,
  `CREATE TABLE task_run_pauses (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    command_id UUID NOT NULL REFERENCES task_pause_commands(id),
    previous_status TEXT NOT NULL CHECK(previous_status IN ('queued','running')),
    paused_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE task_run_pause_checkpoints (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL UNIQUE REFERENCES task_runs(id),
    command_id UUID NOT NULL REFERENCES task_pause_commands(id),
    strategy TEXT NOT NULL CHECK(strategy='restart_from_task_input_v1'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    previous_status TEXT NOT NULL CHECK(previous_status IN ('queued','running')),
    paused_at TIMESTAMPTZ NOT NULL,
    end_byte INTEGER NOT NULL CHECK(end_byte>=0 AND end_byte<=128000)
  )`,
] as const;

export const COL08_PAUSE_REQUIRES_VERSION = '0033_task_pause_checkpoints';

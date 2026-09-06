// Migration 0023 follows the actual retry migration 0022. Existing Tasks become
// roots; the PostgreSQL preflight refuses running legacy Runs before this DDL.
export const TASK_CANCELLATION_SCHEMA_STATEMENTS = [
  'ALTER TABLE tasks ADD COLUMN root_task_id UUID',
  'ALTER TABLE tasks ADD COLUMN parent_task_id UUID REFERENCES tasks(id)',
  'ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0 CHECK(depth>=0)',
  'UPDATE tasks SET root_task_id=id',
  'ALTER TABLE tasks ALTER COLUMN root_task_id SET NOT NULL',
  'CREATE INDEX tasks_root_tree_idx ON tasks(root_task_id,id)',
  'CREATE INDEX tasks_parent_tree_idx ON tasks(parent_task_id,id)',
  "ALTER TABLE tasks ADD CONSTRAINT tasks_cancellation_status CHECK(status IN ('queued','running','completed','failed','cancelled'))",
  "ALTER TABLE task_runs ADD CONSTRAINT task_runs_cancellation_status CHECK(status IN ('queued','running','completed','failed','cancelled'))",
  `ALTER TABLE task_runs ADD CONSTRAINT task_runs_cancellation_fields CHECK (
    (status='queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
    OR (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
    OR (status='completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL AND output_event_id IS NOT NULL)
    OR (status='failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND output_event_id IS NULL)
    OR (status='cancelled' AND finished_at IS NOT NULL AND finished_at>=created_at AND (started_at IS NULL OR finished_at>=started_at)
      AND error_code IS NULL AND output_event_id IS NULL AND (started_at IS NOT NULL OR input_tokens IS NULL))
  )`,
  "ALTER TABLE conversation_delivery_events ADD CONSTRAINT delivery_cancellation_status CHECK(run_status IS NULL OR run_status IN ('queued','running','completed','failed','cancelled'))",
  "ALTER TABLE task_run_delivery_receipts ADD CONSTRAINT delivery_receipt_cancellation_status CHECK(run_status IN ('queued','running','completed','failed','cancelled'))",
  `CREATE TABLE task_cancel_commands (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    root_task_id UUID NOT NULL REFERENCES tasks(id),
    actor_user_id UUID NOT NULL REFERENCES users(id),
    idempotency_key VARCHAR(128) NOT NULL CHECK(idempotency_key<>''),
    expected_run_id UUID NOT NULL REFERENCES task_runs(id),
    attempt INTEGER NOT NULL CHECK(attempt>0),
    cancelled_at TIMESTAMPTZ NOT NULL,
    affected_task_count INTEGER NOT NULL CHECK(affected_task_count>=0),
    affected_run_count INTEGER NOT NULL CHECK(affected_run_count=affected_task_count),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(task_id,actor_user_id,idempotency_key)
  )`,
  `CREATE TABLE task_run_cancellations (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    command_id UUID NOT NULL REFERENCES task_cancel_commands(id),
    previous_status TEXT NOT NULL CHECK(previous_status IN ('queued','running')),
    cancelled_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE task_run_partial_outputs (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    body TEXT NOT NULL CHECK(body<>''),
    end_byte INTEGER NOT NULL CHECK(end_byte>0 AND end_byte<=128000),
    updated_at TIMESTAMPTZ NOT NULL
  )`,
] as const;

export const TASK_CANCELLATION_POSTGRES_PREFLIGHT = [
  'LOCK TABLE tasks,task_runs IN ACCESS EXCLUSIVE MODE',
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM task_runs WHERE status='running') THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Stop new claims and drain legacy workers before migration 0023';
    END IF;
  END $$`,
  'DROP TRIGGER tasks_protected ON tasks',
  'ALTER TABLE tasks DROP CONSTRAINT tasks_status_check',
  'ALTER TABLE task_runs DROP CONSTRAINT task_runs_status_check',
  'ALTER TABLE task_runs DROP CONSTRAINT task_runs_check2',
  'ALTER TABLE conversation_delivery_events DROP CONSTRAINT conversation_delivery_events_run_status_check',
  'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT task_run_delivery_receipts_run_status_check',
] as const;

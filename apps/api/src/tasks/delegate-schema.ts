// Migration 0040 follows 0039. Published 0017/0019/0022/0023/0033/0034/0035/0036/0037/0038/0039
// statement lists stay unchanged. waiting_child is a homologous Task/Run hold
// while exactly one delegated child runs.
export const TASK_DELEGATION_SCHEMA_STATEMENTS = [
  'ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_constraint_1',
  'ALTER TABLE tasks DROP CONSTRAINT tasks_limit_status',
  "ALTER TABLE tasks ADD CONSTRAINT tasks_delegate_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused','waiting_budget','waiting_child'))",
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_constraint_2',
  'ALTER TABLE task_runs DROP CONSTRAINT task_runs_pause_status',
  "ALTER TABLE task_runs ADD CONSTRAINT task_runs_delegate_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused','waiting_child'))",
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_constraint_8',
  'ALTER TABLE task_runs DROP CONSTRAINT task_runs_pause_fields',
  `ALTER TABLE task_runs ADD CONSTRAINT task_runs_delegate_fields CHECK (
    (status='queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
    OR (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
    OR (status='completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL AND output_event_id IS NOT NULL)
    OR (status='failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND output_event_id IS NULL)
    OR (status='cancelled' AND finished_at IS NOT NULL AND finished_at>=created_at AND (started_at IS NULL OR finished_at>=started_at)
      AND error_code IS NULL AND output_event_id IS NULL AND (started_at IS NOT NULL OR input_tokens IS NULL))
    OR (status='paused' AND finished_at IS NOT NULL AND finished_at>=created_at AND (started_at IS NULL OR finished_at>=started_at)
      AND error_code IS NULL AND output_event_id IS NULL AND (started_at IS NOT NULL OR input_tokens IS NULL))
    OR (status='waiting_child' AND finished_at IS NOT NULL AND finished_at>=created_at AND started_at IS NOT NULL AND finished_at>=started_at
      AND error_code IS NULL AND output_event_id IS NULL)
  )`,
  'ALTER TABLE conversation_delivery_events DROP CONSTRAINT IF EXISTS conversation_delivery_events_constraint_3',
  'ALTER TABLE conversation_delivery_events DROP CONSTRAINT delivery_pause_status',
  "ALTER TABLE conversation_delivery_events ADD CONSTRAINT delivery_delegate_status CHECK(run_status IS NULL OR run_status IN ('queued','running','completed','failed','cancelled','paused','waiting_child'))",
  'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT IF EXISTS task_run_delivery_receipts_constraint_1',
  'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT delivery_receipt_pause_status',
  "ALTER TABLE task_run_delivery_receipts ADD CONSTRAINT delivery_receipt_delegate_status CHECK(run_status IN ('queued','running','completed','failed','cancelled','paused','waiting_child'))",
  'ALTER TABLE task_run_cancellations DROP CONSTRAINT IF EXISTS task_run_cancellations_previous_status_check',
  'ALTER TABLE task_run_cancellations DROP CONSTRAINT IF EXISTS task_run_cancellations_constraint_1',
  "ALTER TABLE task_run_cancellations ADD CONSTRAINT task_run_cancellations_delegate_previous CHECK(previous_status IN ('queued','running','waiting_child'))",
  `CREATE TABLE task_delegations (
    parent_run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    parent_task_id UUID NOT NULL REFERENCES tasks(id),
    child_task_id UUID NOT NULL UNIQUE REFERENCES tasks(id),
    action_id VARCHAR(128) NOT NULL CHECK(action_id<>''),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (parent_task_id, parent_run_id)
  )`,
] as const;

export const COL14_DELEGATION_REQUIRES_VERSION = '0040_task_delegation';

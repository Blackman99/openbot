// Migration 0047 follows 0046. Published 0017–0046 statement lists stay
// unchanged. waiting_input and waiting_approval hold the Task while one
// human request is open. Overlay last stays COL-16 until the COL-19
// receipt overlay is applied after it.
export const TASK_HUMAN_REQUEST_SCHEMA_STATEMENTS = [
  'ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_constraint_1',
  'ALTER TABLE tasks DROP CONSTRAINT tasks_delegate_status',
  "ALTER TABLE tasks ADD CONSTRAINT tasks_human_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused','waiting_budget','waiting_child','waiting_input','waiting_approval'))",
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_constraint_2',
  'ALTER TABLE task_runs DROP CONSTRAINT task_runs_delegate_status',
  "ALTER TABLE task_runs ADD CONSTRAINT task_runs_human_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused','waiting_child','waiting_input','waiting_approval'))",
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_constraint_8',
  'ALTER TABLE task_runs DROP CONSTRAINT task_runs_delegate_fields',
  `ALTER TABLE task_runs ADD CONSTRAINT task_runs_human_fields CHECK (
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
    OR (status IN ('waiting_input','waiting_approval') AND finished_at IS NOT NULL AND finished_at>=created_at AND started_at IS NOT NULL AND finished_at>=started_at
      AND error_code IS NULL AND output_event_id IS NULL)
  )`,
  'ALTER TABLE conversation_delivery_events DROP CONSTRAINT IF EXISTS conversation_delivery_events_constraint_3',
  'ALTER TABLE conversation_delivery_events DROP CONSTRAINT delivery_delegate_status',
  "ALTER TABLE conversation_delivery_events ADD CONSTRAINT delivery_human_status CHECK(run_status IS NULL OR run_status IN ('queued','running','completed','failed','cancelled','paused','waiting_child','waiting_input','waiting_approval'))",
  'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT IF EXISTS task_run_delivery_receipts_constraint_1',
  'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT delivery_receipt_delegate_status',
  "ALTER TABLE task_run_delivery_receipts ADD CONSTRAINT delivery_receipt_human_status CHECK(run_status IN ('queued','running','completed','failed','cancelled','paused','waiting_child','waiting_input','waiting_approval'))",
  'ALTER TABLE task_run_cancellations DROP CONSTRAINT IF EXISTS task_run_cancellations_previous_status_check',
  'ALTER TABLE task_run_cancellations DROP CONSTRAINT IF EXISTS task_run_cancellations_constraint_1',
  'ALTER TABLE task_run_cancellations DROP CONSTRAINT IF EXISTS task_run_cancellations_delegate_previous',
  "ALTER TABLE task_run_cancellations ADD CONSTRAINT task_run_cancellations_human_previous CHECK(previous_status IN ('queued','running','waiting_child','waiting_input','waiting_approval'))",
  'ALTER TABLE conversation_events DROP CONSTRAINT conversation_event_identity',
  `ALTER TABLE conversation_events ADD CONSTRAINT conversation_event_identity CHECK (
    (event_type IN ('message.created','message.edited','message.deleted') AND message_id IS NOT NULL AND message_version IS NOT NULL AND membership_id IS NULL AND bot_run_id IS NULL)
    OR (event_type IN ('bot.joined','bot.removed') AND message_id IS NULL AND message_version IS NULL AND membership_id IS NOT NULL AND body IS NULL AND bot_run_id IS NULL)
    OR (event_type='bot.message.created' AND message_id IS NOT NULL AND message_version=1 AND membership_id IS NULL AND bot_run_id IS NOT NULL AND body IS NOT NULL AND reason IS NULL)
    OR (event_type IN ('task.limit.warning','task.handoff','task.input.requested','task.approval.requested','task.human.decided') AND message_id IS NULL AND message_version IS NULL AND membership_id IS NULL AND bot_run_id IS NULL AND body IS NOT NULL AND reason IS NULL)
  )`,
  `CREATE TABLE task_human_requests (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    source_run_id UUID NOT NULL UNIQUE REFERENCES task_runs(id),
    kind TEXT NOT NULL CHECK(kind IN ('input','approval')),
    prompt VARCHAR(8000),
    response_schema JSONB,
    summary VARCHAR(8000),
    event_id UUID NOT NULL UNIQUE REFERENCES conversation_events(id),
    created_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    UNIQUE (task_id, source_run_id),
    CHECK (
      (kind='input' AND prompt IS NOT NULL AND prompt<>'' AND response_schema IS NOT NULL AND summary IS NULL)
      OR (kind='approval' AND summary IS NOT NULL AND summary<>'' AND prompt IS NULL AND response_schema IS NULL)
    )
  )`,
  `CREATE TABLE task_human_decisions (
    request_id UUID PRIMARY KEY REFERENCES task_human_requests(id),
    actor_user_id UUID NOT NULL REFERENCES users(id),
    idempotency_key VARCHAR(128) NOT NULL CHECK(idempotency_key<>''),
    decision TEXT NOT NULL CHECK(decision IN ('input','approve','reject')),
    values JSONB,
    event_id UUID NOT NULL UNIQUE REFERENCES conversation_events(id),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (request_id, actor_user_id, idempotency_key),
    CHECK (
      (decision='input' AND values IS NOT NULL)
      OR (decision IN ('approve','reject') AND values IS NULL)
    )
  )`,
] as const;

export const COL19_HUMAN_REQUEST_REQUIRES_VERSION = '0047_task_human_requests';

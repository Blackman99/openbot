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
    max_turns INTEGER NOT NULL CHECK(max_turns>=0 AND max_turns<=100),
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
  `CREATE TABLE task_limit_events (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('soft_warning','hard_limit')),
    dimension TEXT NOT NULL CHECK (dimension IN ('durationMs','turns','depth','handoffs')),
    usage INTEGER NOT NULL CHECK (usage>=0),
    threshold INTEGER NOT NULL CHECK (threshold>=0),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (task_id,kind,dimension)
  )`,
  `CREATE TABLE task_limit_grants (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    actor_user_id UUID NOT NULL REFERENCES users(id),
    idempotency_key VARCHAR(128) NOT NULL CHECK (idempotency_key<>''),
    dimension TEXT NOT NULL CHECK (dimension IN ('durationMs','turns','depth','handoffs')),
    previous_limit INTEGER NOT NULL CHECK (previous_limit>=0),
    granted_limit INTEGER NOT NULL CHECK (granted_limit>previous_limit),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (task_id,actor_user_id,idempotency_key)
  )`,
  'ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_pause_status',
  'ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_limit_status',
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_pause_status',
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_limit_status',
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_pause_fields',
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_limit_fields',
  'ALTER TABLE conversation_delivery_events DROP CONSTRAINT IF EXISTS delivery_pause_status',
  'ALTER TABLE conversation_delivery_events DROP CONSTRAINT IF EXISTS delivery_limit_status',
  'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT IF EXISTS delivery_receipt_pause_status',
  'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT IF EXISTS delivery_receipt_limit_status',
  "ALTER TABLE tasks ADD CONSTRAINT tasks_limit_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused','waiting_budget'))",
  "ALTER TABLE task_runs ADD CONSTRAINT task_runs_limit_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused','waiting_budget'))",
  `ALTER TABLE task_runs ADD CONSTRAINT task_runs_limit_fields CHECK (
    (status='queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
    OR (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
    OR (status='completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL AND output_event_id IS NOT NULL)
    OR (status='failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND output_event_id IS NULL)
    OR (status='cancelled' AND finished_at IS NOT NULL AND finished_at>=created_at AND (started_at IS NULL OR finished_at>=started_at)
      AND error_code IS NULL AND output_event_id IS NULL AND (started_at IS NOT NULL OR input_tokens IS NULL))
    OR (status='paused' AND finished_at IS NOT NULL AND finished_at>=created_at AND (started_at IS NULL OR finished_at>=started_at)
      AND error_code IS NULL AND output_event_id IS NULL AND (started_at IS NOT NULL OR input_tokens IS NULL))
    OR (status='waiting_budget' AND finished_at IS NOT NULL AND finished_at>=created_at AND (started_at IS NULL OR finished_at>=started_at)
      AND error_code IS NULL AND output_event_id IS NULL AND (started_at IS NOT NULL OR input_tokens IS NULL))
  )`,
  "ALTER TABLE conversation_delivery_events ADD CONSTRAINT delivery_limit_status CHECK(run_status IS NULL OR run_status IN ('queued','running','completed','failed','cancelled','paused','waiting_budget'))",
  "ALTER TABLE task_run_delivery_receipts ADD CONSTRAINT delivery_receipt_limit_status CHECK(run_status IN ('queued','running','completed','failed','cancelled','paused','waiting_budget'))",
] as const;

export const COL12_LIMITS_REQUIRES_VERSION = '0036_task_execution_limit_snapshots';

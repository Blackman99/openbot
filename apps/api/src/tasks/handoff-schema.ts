// Migration 0044 follows 0043. Published 0017/0022/0035/0037/0040/0043
// statement lists stay unchanged. A committed handoff records one Lead
// transfer per source Run and admits handed_off as a terminal Run error.
export const TASK_HANDOFF_SCHEMA_STATEMENTS = [
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_error_code_check',
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_constraint_5',
  `ALTER TABLE task_runs ADD CONSTRAINT task_runs_error_code_check CHECK (
    error_code IS NULL OR error_code IN (
      'execution_forbidden','model_unavailable','provider_failed','execution_timeout',
      'output_limit','context_limit','worker_stopped','worker_interrupted','handed_off'
    )
  )`,
  'ALTER TABLE conversation_events DROP CONSTRAINT conversation_event_identity',
  `ALTER TABLE conversation_events ADD CONSTRAINT conversation_event_identity CHECK (
    (event_type IN ('message.created','message.edited','message.deleted') AND message_id IS NOT NULL AND message_version IS NOT NULL AND membership_id IS NULL AND bot_run_id IS NULL)
    OR (event_type IN ('bot.joined','bot.removed') AND message_id IS NULL AND message_version IS NULL AND membership_id IS NOT NULL AND body IS NULL AND bot_run_id IS NULL)
    OR (event_type='bot.message.created' AND message_id IS NOT NULL AND message_version=1 AND membership_id IS NULL AND bot_run_id IS NOT NULL AND body IS NOT NULL AND reason IS NULL)
    OR (event_type IN ('task.limit.warning','task.handoff') AND message_id IS NULL AND message_version IS NULL AND membership_id IS NULL AND bot_run_id IS NULL AND body IS NOT NULL AND reason IS NULL)
  )`,
  `CREATE TABLE task_handoffs (
    source_run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    source_grant_id UUID NOT NULL REFERENCES group_bot_grants(id),
    source_bot_id UUID NOT NULL,
    target_grant_id UUID NOT NULL REFERENCES group_bot_grants(id),
    target_bot_id UUID NOT NULL,
    target_bot_version_id UUID NOT NULL,
    reason VARCHAR(8000) NOT NULL CHECK (reason<>''),
    event_id UUID NOT NULL UNIQUE REFERENCES conversation_events(id),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (task_id, source_run_id),
    CHECK (source_grant_id<>target_grant_id),
    CHECK (source_bot_id<>target_bot_id)
  )`,
] as const;

export const COL16_HANDOFF_REQUIRES_VERSION = '0044_task_lead_handoffs';

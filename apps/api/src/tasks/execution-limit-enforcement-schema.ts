// Migration 0037 follows 0036. Published 0017/0019/0022/0023/0033/0034/0035/0036
// statement lists stay unchanged. waiting_budget is a Task-only hold; the
// current Run keeps its prior queued/failed/paused state so no further Run
// starts until an authorized grant (later slice) resumes it.
export const TASK_EXECUTION_LIMIT_ENFORCEMENT_SCHEMA_STATEMENTS = [
  // pg-mem keeps the unnamed 0017 status CHECK as tasks_constraint_1 after
  // the named pause replacement. Native PostgreSQL only has tasks_pause_status.
  'ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_constraint_1',
  'ALTER TABLE tasks DROP CONSTRAINT tasks_pause_status',
  "ALTER TABLE tasks ADD CONSTRAINT tasks_limit_status CHECK(status IN ('queued','running','completed','failed','cancelled','paused','waiting_budget'))",
  'ALTER TABLE conversation_events DROP CONSTRAINT conversation_event_identity',
  `ALTER TABLE conversation_events ADD CONSTRAINT conversation_event_identity CHECK (
    (event_type IN ('message.created','message.edited','message.deleted') AND message_id IS NOT NULL AND message_version IS NOT NULL AND membership_id IS NULL AND bot_run_id IS NULL)
    OR (event_type IN ('bot.joined','bot.removed') AND message_id IS NULL AND message_version IS NULL AND membership_id IS NOT NULL AND body IS NULL AND bot_run_id IS NULL)
    OR (event_type='bot.message.created' AND message_id IS NOT NULL AND message_version=1 AND membership_id IS NULL AND bot_run_id IS NOT NULL AND body IS NOT NULL AND reason IS NULL)
    OR (event_type='task.limit.warning' AND message_id IS NULL AND message_version IS NULL AND membership_id IS NULL AND bot_run_id IS NULL AND body IS NOT NULL AND reason IS NULL)
  )`,
  `CREATE TABLE task_execution_limit_warnings (
    task_id UUID NOT NULL REFERENCES tasks(id),
    dimension TEXT NOT NULL CHECK(dimension IN ('duration','turns','delegationDepth','handoffs')),
    used BIGINT NOT NULL CHECK(used>=0 AND used<=9007199254740991),
    limit_value BIGINT NOT NULL CHECK(limit_value>=0 AND limit_value<=9007199254740991),
    source TEXT NOT NULL CHECK(source IN ('workspace','group','task','run')),
    event_id UUID NOT NULL UNIQUE REFERENCES conversation_events(id),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (task_id, dimension)
  )`,
] as const;

export const COL12_ENFORCEMENT_REQUIRES_VERSION = '0037_task_execution_limit_enforcement';

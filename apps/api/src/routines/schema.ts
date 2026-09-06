// Migration 0051 follows published 0050_workspace_event_stream. One-time
// collaboration routines store their schedule and budget. Migration 0052 adds
// occurrence uniqueness so concurrent workers cannot create duplicate tasks.
export const ROUTINE_SCHEMA_STATEMENTS = [
  `CREATE TABLE routines (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    group_id UUID NOT NULL REFERENCES groups(id),
    owner_user_id UUID NOT NULL REFERENCES users(id),
    prompt TEXT NOT NULL CHECK (prompt <> ''),
    lead_grant_id UUID REFERENCES group_bot_grants(id),
    routing_policy TEXT NOT NULL CHECK (routing_policy IN ('lead', 'group')),
    time_zone TEXT NOT NULL CHECK (time_zone <> ''),
    execute_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    max_cost_micros BIGINT NOT NULL CHECK (max_cost_micros > 0 AND max_cost_micros <= 9007199254740991),
    kind TEXT NOT NULL CHECK (kind = 'one_time'),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled', 'completed', 'expired')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (
      (routing_policy = 'lead' AND lead_grant_id IS NOT NULL)
      OR (routing_policy = 'group' AND lead_grant_id IS NULL)
    ),
    CHECK (expires_at > execute_at),
    CHECK (updated_at >= created_at),
    FOREIGN KEY (workspace_id, group_id) REFERENCES groups(workspace_id, id)
  )`,
  'CREATE INDEX routines_group_idx ON routines(workspace_id, group_id, execute_at, id)',
  'CREATE INDEX routines_due_idx ON routines(status, execute_at, id)',
] as const;

// UNIQUE (routine_id, occurrence_key) is the concurrent-worker guard (AC5).
// Workers insert the occurrence row before creating the task so a second worker
// cannot claim the same occurrence; task_id is filled before commit.
export const ROUTINE_OCCURRENCE_SCHEMA_STATEMENTS = [
  `CREATE TABLE routine_occurrences (
    id UUID PRIMARY KEY,
    routine_id UUID NOT NULL REFERENCES routines(id),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    occurrence_key TEXT NOT NULL CHECK (occurrence_key <> ''),
    task_id UUID REFERENCES tasks(id),
    conversation_id UUID REFERENCES conversations(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('created', 'expired')),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (routine_id, occurrence_key),
    FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id),
    CHECK (
      (outcome = 'expired' AND task_id IS NULL AND conversation_id IS NULL)
      OR outcome = 'created'
    )
  )`,
  'CREATE INDEX routine_occurrences_task_idx ON routine_occurrences(task_id) WHERE task_id IS NOT NULL',
  'CREATE INDEX routine_occurrences_routine_idx ON routine_occurrences(routine_id, created_at, id)',
] as const;

export const ROUT01_ROUTINES_REQUIRES_VERSION = '0051_routines';
export const ROUT01_OCCURRENCES_REQUIRES_VERSION = '0052_routine_occurrences';

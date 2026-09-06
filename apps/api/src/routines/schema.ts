// Migration 0051 follows published 0050_workspace_event_stream. One-time
// collaboration routines store their schedule and budget; execution and
// occurrence uniqueness land in later ROUT-01 slices. Imported template stubs
// remain in group_imported_routines (disabled) until an owner enables a real
// routine definition.
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

export const ROUT01_ROUTINES_REQUIRES_VERSION = '0051_routines';

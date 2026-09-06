// Migration 0050 follows published 0049_group_archive. Workspace/task public
// SSE delivery is a reclaimable ordered projection separate from conversation
// sequences; domain producers append into this ledger in later API-06 slices.
export const WORKSPACE_EVENT_STREAM_SCHEMA_STATEMENTS = [
  `CREATE TABLE workspace_event_streams (
    workspace_id UUID PRIMARY KEY REFERENCES workspaces(id),
    last_sequence BIGINT NOT NULL DEFAULT 0
      CHECK (last_sequence>=0 AND last_sequence<=9007199254740991),
    floor BIGINT NOT NULL DEFAULT 0
      CHECK (floor>=0 AND floor<=9007199254740991),
    retained_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_count>=0),
    retained_bytes BIGINT NOT NULL DEFAULT 0 CHECK (retained_bytes>=0),
    CHECK (floor<=last_sequence)
  )`,
  `INSERT INTO workspace_event_streams(workspace_id, last_sequence, floor)
    SELECT id, 0, 0 FROM workspaces`,
  `CREATE TABLE workspace_events (
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    sequence BIGINT NOT NULL CHECK (sequence>0 AND sequence<=9007199254740991),
    occurred_at TIMESTAMPTZ NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'task.terminal','task.cancelled','task.approval','task.budget_exhausted','task.updated'
    )),
    payload JSONB NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size>=64 AND byte_size<=262144),
    PRIMARY KEY (workspace_id, sequence)
  )`,
  'CREATE INDEX workspace_events_expiry_idx ON workspace_events(occurred_at, workspace_id, sequence)',
] as const;

export const API06_WORKSPACE_EVENT_STREAM_REQUIRES_VERSION = '0050_workspace_event_stream';

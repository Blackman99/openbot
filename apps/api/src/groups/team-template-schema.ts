export const TEAM_TEMPLATE_SCHEMA_STATEMENTS = [
  `CREATE TABLE group_imported_routines (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    routine_key TEXT NOT NULL CHECK (routine_key <> ''),
    name TEXT NOT NULL CHECK (name <> ''),
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (group_id, routine_key),
    CONSTRAINT group_imported_routines_disabled CHECK (enabled = false)
  )`,
  'CREATE INDEX group_imported_routines_group_idx ON group_imported_routines(group_id)',
] as const;

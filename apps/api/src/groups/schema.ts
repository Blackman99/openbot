export const GROUP_SCHEMA_STATEMENTS = [
  `CREATE TABLE groups (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name <> ''),
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX groups_workspace_idx ON groups(workspace_id)',
  `CREATE TABLE group_memberships (
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (group_id, user_id)
  )`,
  'CREATE INDEX group_memberships_user_idx ON group_memberships(user_id)',
] as const;

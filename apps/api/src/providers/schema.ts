export const PERSONAL_MODEL_CONNECTION_STATEMENTS = [
  `CREATE TABLE personal_model_connections (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    metadata JSONB NOT NULL,
    sealed_credentials TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX personal_model_connections_owner_idx ON personal_model_connections(owner_user_id)',
] as const;

export const WORKSPACE_MODEL_CONNECTION_STATEMENTS = [
  `CREATE TABLE workspace_model_connections (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    metadata JSONB NOT NULL,
    sealed_credentials TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX workspace_model_connections_workspace_idx ON workspace_model_connections(workspace_id)',
] as const;

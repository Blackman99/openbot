// Migration 0045 follows 0044. Published 0017–0044 statement lists stay
// unchanged. Workspace Admins version model prices; an active row is the
// one whose superseded_at is still null.
export const MODEL_PRICE_SCHEMA_STATEMENTS = [
  `CREATE TABLE model_price_versions (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    connection_id UUID NOT NULL,
    model_id TEXT NOT NULL CHECK(model_id<>''),
    input_micros_per_million BIGINT NOT NULL CHECK(input_micros_per_million>=0),
    output_micros_per_million BIGINT NOT NULL CHECK(output_micros_per_million>=0),
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL,
    superseded_at TIMESTAMPTZ
  )`,
  'CREATE INDEX model_price_versions_workspace_idx ON model_price_versions(workspace_id,connection_id,model_id,created_at)',
  `ALTER TABLE task_runs ADD COLUMN price_version_id UUID REFERENCES model_price_versions(id)`,
] as const;

export const COL18_MODEL_PRICE_REQUIRES_VERSION = '0045_model_price_versions';

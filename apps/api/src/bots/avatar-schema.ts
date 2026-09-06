export const AVATAR_SCHEMA_STATEMENTS = [
  `CREATE TABLE avatar_objects (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    bot_id UUID NOT NULL REFERENCES bots(id),
    backend_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged','live','deleting','deleted')),
    bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 2097152),
    sha256 TEXT NOT NULL,
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 512),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 512),
    created_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    cleanup_after TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    cleanup_token UUID
  )`,
  'CREATE INDEX avatar_cleanup_idx ON avatar_objects(cleanup_after)',
  `CREATE TABLE bot_avatar_references (
    version_id UUID PRIMARY KEY REFERENCES bot_versions(id),
    object_id UUID NOT NULL REFERENCES avatar_objects(id)
  )`,
  'CREATE INDEX bot_avatar_object_idx ON bot_avatar_references(object_id)',
] as const;
export const AVATAR_POSTGRES_GUARDS = [
  `CREATE TRIGGER bot_avatar_references_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON bot_avatar_references
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bot_version_mutation()`,
] as const;

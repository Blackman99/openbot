export const BOT_SCHEMA_STATEMENTS = [
  `CREATE TABLE bots (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    current_version_id UUID NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','workspace')),
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX bots_workspace_idx ON bots(workspace_id)',
  `CREATE TABLE bot_versions (
    id UUID PRIMARY KEY,
    bot_id UUID NOT NULL REFERENCES bots(id),
    version INTEGER NOT NULL CHECK (version > 0),
    configuration JSONB NOT NULL,
    author_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL,
    rationale TEXT NOT NULL,
    UNIQUE (bot_id,version),
    UNIQUE (bot_id,id)
  )`,
  `CREATE TABLE bot_acl (
    bot_id UUID NOT NULL REFERENCES bots(id),
    user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('owner','editor','user')),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (bot_id,user_id)
  )`,
  'CREATE INDEX bot_acl_user_idx ON bot_acl(user_id)',
] as const;

// pg-mem cannot prove deferred foreign keys or PostgreSQL trigger/privilege
// semantics. Production migrations install these guards; the native suite is
// the required evidence for their enforcement.
export const BOT_POSTGRES_GUARD_STATEMENTS = [
  `ALTER TABLE bots ADD CONSTRAINT bots_current_version_same_bot
    FOREIGN KEY (id,current_version_id) REFERENCES bot_versions(bot_id,id)
    DEFERRABLE INITIALLY DEFERRED`,
  `CREATE FUNCTION reject_bot_version_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='bot_versions is immutable';
    END;
    $$`,
  `CREATE TRIGGER bot_versions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON bot_versions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_bot_version_mutation()`,
] as const;

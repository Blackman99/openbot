export const CONVERSATION_SCHEMA_STATEMENTS = [
  'ALTER TABLE groups ADD CONSTRAINT groups_conversation_subject_key UNIQUE (workspace_id,id)',
  'ALTER TABLE bots ADD CONSTRAINT bots_conversation_subject_key UNIQUE (workspace_id,id)',
  `CREATE TABLE conversations (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    group_id UUID UNIQUE,
    bot_id UUID,
    creator_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL,
    last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0 AND last_sequence <= 9007199254740991),
    CHECK ((group_id IS NOT NULL AND bot_id IS NULL) OR (group_id IS NULL AND bot_id IS NOT NULL)),
    UNIQUE (workspace_id,bot_id,creator_user_id),
    FOREIGN KEY (workspace_id,group_id) REFERENCES groups(workspace_id,id),
    FOREIGN KEY (workspace_id,bot_id) REFERENCES bots(workspace_id,id)
  )`,
  `CREATE TABLE conversation_events (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    sequence BIGINT NOT NULL CHECK (sequence > 0 AND sequence <= 9007199254740991),
    message_id UUID NOT NULL,
    message_version INTEGER NOT NULL DEFAULT 1 CHECK (message_version > 0),
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    actor_user_id UUID NOT NULL REFERENCES users(id),
    occurred_at TIMESTAMPTZ NOT NULL,
    body TEXT,
    reason TEXT,
    idempotency_key TEXT NOT NULL,
    command_hash CHAR(64) NOT NULL,
    UNIQUE (conversation_id, sequence),
    UNIQUE (conversation_id, message_id, message_version),
    UNIQUE (conversation_id, actor_user_id, idempotency_key)
  )`,
  'CREATE INDEX conversation_events_message_idx ON conversation_events(conversation_id,message_id,sequence)',
] as const;

export const CONVERSATION_POSTGRES_GUARDS = [
  `CREATE FUNCTION reject_conversation_event_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='conversation ledger is append-only';
    END;
    $$`,
  `CREATE TRIGGER conversation_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON conversation_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE TRIGGER conversations_retained BEFORE DELETE OR TRUNCATE ON conversations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION protect_conversation_subject() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF ROW(NEW.id,NEW.workspace_id,NEW.group_id,NEW.bot_id,NEW.creator_user_id,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.group_id,OLD.bot_id,OLD.creator_user_id,OLD.created_at)
        OR NEW.last_sequence <> OLD.last_sequence + 1 THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='conversation subject is immutable';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER conversations_subject_immutable BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION protect_conversation_subject()`,
] as const;

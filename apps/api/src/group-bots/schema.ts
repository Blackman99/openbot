export const GROUP_BOT_SCHEMA_STATEMENTS = [
  'ALTER TABLE conversation_events ALTER COLUMN message_id DROP NOT NULL',
  'ALTER TABLE conversation_events ALTER COLUMN message_version DROP NOT NULL',
  'ALTER TABLE conversation_events ALTER COLUMN message_version DROP DEFAULT',
  'ALTER TABLE conversation_events ADD COLUMN membership_id UUID',
  "ALTER TABLE conversation_events ADD COLUMN event_data JSONB NOT NULL DEFAULT '{}'::jsonb",
  `ALTER TABLE conversation_events ADD CONSTRAINT conversation_event_identity CHECK (
    (event_type IN ('message.created','message.edited','message.deleted') AND message_id IS NOT NULL AND message_version IS NOT NULL AND membership_id IS NULL)
    OR (event_type IN ('bot.joined','bot.removed') AND message_id IS NULL AND message_version IS NULL AND membership_id IS NOT NULL AND body IS NULL)
  )`,
  'ALTER TABLE conversations ADD CONSTRAINT conversations_group_grant_key UNIQUE (workspace_id,group_id,id)',
  `CREATE TABLE group_bot_grants (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    group_id UUID NOT NULL,
    bot_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    granted_by_user_id UUID NOT NULL REFERENCES users(id),
    history_mode TEXT NOT NULL CHECK (history_mode IN ('future-only','since-event','since-time','all')),
    lower_bound BIGINT NOT NULL CHECK (lower_bound > 0),
    source_event_id UUID REFERENCES conversation_events(id),
    source_time TIMESTAMPTZ,
    join_event_id UUID NOT NULL UNIQUE REFERENCES conversation_events(id),
    join_sequence BIGINT NOT NULL CHECK (join_sequence > 0 AND lower_bound <= join_sequence),
    joined_at TIMESTAMPTZ NOT NULL,
    CHECK ((history_mode IN ('future-only','all') AND source_event_id IS NULL AND source_time IS NULL)
      OR (history_mode='since-event' AND source_event_id IS NOT NULL AND source_time IS NULL)
      OR (history_mode='since-time' AND source_event_id IS NULL AND source_time IS NOT NULL)),
    CHECK (history_mode <> 'all' OR lower_bound=1),
    CHECK (history_mode <> 'future-only' OR lower_bound=join_sequence),
    close_event_id UUID UNIQUE REFERENCES conversation_events(id),
    close_sequence BIGINT,
    closed_at TIMESTAMPTZ,
    closure_reason TEXT,
    FOREIGN KEY (workspace_id,group_id,conversation_id) REFERENCES conversations(workspace_id,group_id,id),
    FOREIGN KEY (workspace_id,bot_id) REFERENCES bots(workspace_id,id),
    CHECK ((close_event_id IS NULL AND close_sequence IS NULL AND closed_at IS NULL AND closure_reason IS NULL)
      OR (close_event_id IS NOT NULL AND close_sequence > join_sequence AND closed_at IS NOT NULL AND closure_reason IN ('removed','bot-access-revoked','workspace-access-removed')))
  )`,
  'CREATE UNIQUE INDEX group_bot_active_key ON group_bot_grants(group_id,bot_id) WHERE close_event_id IS NULL',
  'CREATE INDEX group_bot_grantor_idx ON group_bot_grants(workspace_id,granted_by_user_id,bot_id)',
] as const;

// Applied only by real PostgreSQL migrations; pg-mem cannot execute PL/pgSQL.
export const GROUP_BOT_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_group_bot_grant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.workspace_id,NEW.group_id,NEW.bot_id,NEW.conversation_id,NEW.granted_by_user_id,
          NEW.history_mode,NEW.lower_bound,NEW.source_event_id,NEW.source_time,NEW.join_event_id,NEW.join_sequence,NEW.joined_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.group_id,OLD.bot_id,OLD.conversation_id,OLD.granted_by_user_id,
          OLD.history_mode,OLD.lower_bound,OLD.source_event_id,OLD.source_time,OLD.join_event_id,OLD.join_sequence,OLD.joined_at)
          OR OLD.close_event_id IS NOT NULL OR NEW.close_event_id IS NULL THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='group Bot grant is immutable after closure';
        END IF;
      ELSIF NEW.close_event_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='new group Bot grant must be active';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.id=NEW.join_event_id
        AND e.conversation_id=NEW.conversation_id AND e.sequence=NEW.join_sequence
        AND e.occurred_at=NEW.joined_at AND e.event_type='bot.joined' AND e.membership_id=NEW.id
        AND e.actor_user_id=NEW.granted_by_user_id AND e.event_data->>'botId'=NEW.bot_id::text
        AND e.event_data->>'groupId'=NEW.group_id::text) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='group Bot grant requires its join event';
      END IF;
      IF NEW.source_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_events e
        WHERE e.id=NEW.source_event_id AND e.conversation_id=NEW.conversation_id AND e.sequence=NEW.lower_bound) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='history source must belong to the conversation';
      END IF;
      IF NEW.close_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_events e
        WHERE e.id=NEW.close_event_id AND e.conversation_id=NEW.conversation_id
        AND e.sequence=NEW.close_sequence AND e.occurred_at=NEW.closed_at
        AND e.event_type='bot.removed' AND e.membership_id=NEW.id
        AND e.event_data->>'botId'=NEW.bot_id::text AND e.event_data->>'groupId'=NEW.group_id::text
        AND e.event_data->>'grantorUserId'=NEW.granted_by_user_id::text
        AND e.event_data->>'reason'=NEW.closure_reason) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='group Bot grant requires its closure event';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER group_bot_grants_protected BEFORE INSERT OR UPDATE ON group_bot_grants
    FOR EACH ROW EXECUTE FUNCTION protect_group_bot_grant()`,
  `CREATE TRIGGER group_bot_grants_retained BEFORE DELETE OR TRUNCATE ON group_bot_grants
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
] as const;

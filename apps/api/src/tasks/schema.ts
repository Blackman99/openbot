// Migration 0017 follows the immutable Bot lifecycle migration 0016.
export const TASK_SCHEMA_STATEMENTS = [
  'ALTER TABLE conversation_events ADD CONSTRAINT conversation_task_trigger_key UNIQUE (conversation_id,actor_user_id,id)',
  `CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    bot_id UUID NOT NULL,
    bot_version_id UUID NOT NULL,
    group_grant_id UUID REFERENCES group_bot_grants(id),
    execution_user_id UUID NOT NULL REFERENCES users(id),
    trigger_event_id UUID NOT NULL UNIQUE,
    command_hash CHAR(64) NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (workspace_id,bot_id) REFERENCES bots(workspace_id,id),
    FOREIGN KEY (bot_id,bot_version_id) REFERENCES bot_versions(bot_id,id),
    FOREIGN KEY (conversation_id,execution_user_id,trigger_event_id) REFERENCES conversation_events(conversation_id,actor_user_id,id)
  )`,
  `CREATE TABLE task_runs (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    claim_token UUID,
    deadline_at TIMESTAMPTZ,
    provider_scope_kind TEXT CHECK (provider_scope_kind IS NULL OR provider_scope_kind IN ('personal','workspace')),
    provider_scope_id UUID,
    connection_id UUID,
    connection_revision INTEGER,
    protocol TEXT CHECK (protocol IS NULL OR protocol IN ('openai-chat','openai-responses','anthropic-messages')),
    model_id TEXT,
    input_tokens BIGINT,
    output_tokens BIGINT,
    error_code TEXT CHECK (error_code IS NULL OR error_code IN ('execution_forbidden','model_unavailable','provider_failed','execution_timeout','output_limit','context_limit','worker_stopped')),
    output_event_id UUID UNIQUE REFERENCES conversation_events(id),
    UNIQUE(task_id,attempt),
    CHECK ((input_tokens IS NULL AND output_tokens IS NULL) OR
      (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND input_tokens>=0 AND output_tokens>=0 AND input_tokens<=9007199254740991 AND output_tokens<=9007199254740991)),
    CHECK ((started_at IS NULL AND claim_token IS NULL AND deadline_at IS NULL AND provider_scope_kind IS NULL AND provider_scope_id IS NULL AND connection_id IS NULL AND connection_revision IS NULL AND protocol IS NULL AND model_id IS NULL)
      OR (started_at IS NOT NULL AND claim_token IS NOT NULL AND deadline_at IS NOT NULL AND deadline_at>started_at AND provider_scope_kind IS NOT NULL AND provider_scope_id IS NOT NULL AND connection_id IS NOT NULL AND connection_revision IS NOT NULL AND connection_revision>=0 AND protocol IS NOT NULL AND model_id IS NOT NULL)),
    CHECK ((status='queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
      OR (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL AND output_event_id IS NULL AND input_tokens IS NULL)
      OR (status='completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL AND output_event_id IS NOT NULL)
      OR (status='failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND output_event_id IS NULL))
  )`,
  'CREATE INDEX tasks_conversation_idx ON tasks(conversation_id,created_at,id)',
  'CREATE INDEX task_runs_queue_idx ON task_runs(status,created_at,id)',
  'ALTER TABLE conversation_events ADD COLUMN bot_run_id UUID UNIQUE REFERENCES task_runs(id)',
  'ALTER TABLE conversation_events DROP CONSTRAINT conversation_event_identity',
  `ALTER TABLE conversation_events ADD CONSTRAINT conversation_event_identity CHECK (
    (event_type IN ('message.created','message.edited','message.deleted') AND message_id IS NOT NULL AND message_version IS NOT NULL AND membership_id IS NULL AND bot_run_id IS NULL)
    OR (event_type IN ('bot.joined','bot.removed') AND message_id IS NULL AND message_version IS NULL AND membership_id IS NOT NULL AND body IS NULL AND bot_run_id IS NULL)
    OR (event_type='bot.message.created' AND message_id IS NOT NULL AND message_version=1 AND membership_id IS NULL AND bot_run_id IS NOT NULL AND body IS NOT NULL AND reason IS NULL)
  )`,
] as const;

// PostgreSQL enforces retained identities and one-way state transitions even
// for an accidental write outside the authorized service transaction.
export const TASK_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_task() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.workspace_id,NEW.conversation_id,NEW.bot_id,NEW.bot_version_id,
          NEW.group_grant_id,NEW.execution_user_id,NEW.trigger_event_id,NEW.command_hash,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.conversation_id,OLD.bot_id,OLD.bot_version_id,
          OLD.group_grant_id,OLD.execution_user_id,OLD.trigger_event_id,OLD.command_hash,OLD.created_at)
          OR NOT ((OLD.status='queued' AND NEW.status IN ('running','failed'))
            OR (OLD.status='running' AND NEW.status IN ('completed','failed'))) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task identity and terminal state are immutable';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id=NEW.id AND r.attempt=1 AND r.status=NEW.status) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Task state must match its Run';
        END IF;
      ELSIF NEW.status<>'queued' THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='new Task must be queued';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM conversations c JOIN conversation_events e ON e.conversation_id=c.id
        WHERE c.id=NEW.conversation_id AND c.workspace_id=NEW.workspace_id AND e.id=NEW.trigger_event_id
        AND e.actor_user_id=NEW.execution_user_id AND e.event_type='message.created'
        AND e.command_hash=NEW.command_hash
        AND ((c.group_id IS NULL AND c.bot_id=NEW.bot_id AND c.creator_user_id=NEW.execution_user_id AND NEW.group_grant_id IS NULL)
          OR (c.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM group_bot_grants g
            WHERE g.id=NEW.group_grant_id AND g.workspace_id=c.workspace_id AND g.group_id=c.group_id
            AND g.conversation_id=c.id AND g.bot_id=NEW.bot_id AND e.sequence>=g.lower_bound)))) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Task requires its human trigger and exact target';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER tasks_protected BEFORE INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION protect_task()`,
  `CREATE TRIGGER tasks_retained BEFORE DELETE OR TRUNCATE ON tasks
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION protect_task_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.attempt<>1 OR NEW.status<>'queued' OR NOT EXISTS
          (SELECT 1 FROM tasks t WHERE t.id=NEW.task_id AND t.status='queued') THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='first Task Run must be queued';
        END IF;
      ELSE
        IF ROW(NEW.id,NEW.task_id,NEW.attempt,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.task_id,OLD.attempt,OLD.created_at)
          OR NOT ((OLD.status='queued' AND NEW.status IN ('running','failed'))
            OR (OLD.status='running' AND NEW.status IN ('completed','failed'))) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Run identity and terminal state are immutable';
        END IF;
        IF OLD.status='running' AND ROW(NEW.started_at,NEW.claim_token,NEW.deadline_at,NEW.provider_scope_kind,
          NEW.provider_scope_id,NEW.connection_id,NEW.connection_revision,NEW.protocol,NEW.model_id)
          IS DISTINCT FROM ROW(OLD.started_at,OLD.claim_token,OLD.deadline_at,OLD.provider_scope_kind,
          OLD.provider_scope_id,OLD.connection_id,OLD.connection_revision,OLD.protocol,OLD.model_id) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Run claim and provider identity are immutable';
        END IF;
        IF NEW.started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t
          JOIN bot_versions v ON v.id=t.bot_version_id AND v.bot_id=t.bot_id
          WHERE t.id=NEW.task_id
          AND v.configuration->'modelBinding'->'scope'->>'kind'=NEW.provider_scope_kind
          AND v.configuration->'modelBinding'->'scope'->>'id'=NEW.provider_scope_id::text
          AND v.configuration->'modelBinding'->>'connectionId'=NEW.connection_id::text
          AND v.configuration->'modelBinding'->>'modelId'=NEW.model_id
          AND ((NEW.provider_scope_kind='personal' AND NEW.provider_scope_id=t.execution_user_id)
            OR (NEW.provider_scope_kind='workspace' AND NEW.provider_scope_id=t.workspace_id))) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Run must retain its admitted model binding';
        END IF;
        IF NEW.status='completed' AND NOT EXISTS (SELECT 1 FROM conversation_events e
          JOIN tasks t ON t.id=NEW.task_id WHERE e.id=NEW.output_event_id AND e.bot_run_id=NEW.id
          AND e.conversation_id=t.conversation_id AND e.event_type='bot.message.created') THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='completed Run requires its Bot output';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER task_runs_protected BEFORE INSERT OR UPDATE ON task_runs
    FOR EACH ROW EXECUTE FUNCTION protect_task_run()`,
  `CREATE TRIGGER task_runs_retained BEFORE DELETE OR TRUNCATE ON task_runs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION protect_bot_output() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_type='bot.message.created' THEN
        IF length(btrim(NEW.body))=0 OR length(NEW.body)>32000 OR octet_length(NEW.body)>128000
          OR NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id
            JOIN bot_versions v ON v.id=t.bot_version_id AND v.bot_id=t.bot_id
            WHERE r.id=NEW.bot_run_id AND r.status='running' AND t.status='running'
            AND r.deadline_at>CURRENT_TIMESTAMP AND t.conversation_id=NEW.conversation_id
            AND t.execution_user_id=NEW.actor_user_id
            AND NEW.event_data=jsonb_build_object('taskId',t.id::text,'runId',r.id::text,
              'bot',jsonb_build_object('id',t.bot_id::text,'displayName',v.configuration->>'name',
                'versionId',t.bot_version_id::text,'versionNumber',v.version))) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Bot output requires its running Task identity';
        END IF;
      ELSIF NEW.event_type IN ('message.edited','message.deleted') AND EXISTS
        (SELECT 1 FROM conversation_events e WHERE e.conversation_id=NEW.conversation_id
          AND e.message_id=NEW.message_id AND e.event_type='bot.message.created') THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Bot output cannot become a human mutation';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER conversation_bot_output_protected BEFORE INSERT ON conversation_events
    FOR EACH ROW EXECUTE FUNCTION protect_bot_output()`,
] as const;

// Migration 0022 follows the actual delivery, memory and routing migrations.
export const TASK_RETRY_SCHEMA_STATEMENTS = [
  'ALTER TABLE task_runs ADD CONSTRAINT task_runs_retry_identity UNIQUE (task_id,id)',
  `CREATE TABLE task_retry_commands (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id),
    actor_user_id UUID NOT NULL REFERENCES users(id),
    expected_run_id UUID NOT NULL,
    run_id UUID NOT NULL UNIQUE,
    idempotency_key VARCHAR(128) NOT NULL CHECK (idempotency_key<>''),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (task_id,actor_user_id,idempotency_key),
    FOREIGN KEY (task_id,expected_run_id) REFERENCES task_runs(task_id,id),
    FOREIGN KEY (task_id,run_id) REFERENCES task_runs(task_id,id),
    CHECK (expected_run_id<>run_id)
  )`,
] as const;

// These replace the 0017 guards only in the new migration. The current Task
// projection may advance to a new queued Run; no existing Run can reopen.
export const TASK_RETRY_POSTGRES_GUARDS = [
  `CREATE OR REPLACE FUNCTION protect_task() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE latest task_runs%ROWTYPE;
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')
          OR NOT ((OLD.status='queued' AND NEW.status IN ('running','failed'))
            OR (OLD.status='running' AND NEW.status IN ('completed','failed'))
            OR (OLD.status='failed' AND NEW.status='queued')) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task identity and completed state are immutable';
        END IF;
        SELECT r.* INTO latest FROM task_runs r WHERE r.task_id=NEW.id ORDER BY r.attempt DESC LIMIT 1;
        IF OLD.status='failed' AND NEW.status='queued' AND NOT EXISTS (
          SELECT 1 FROM task_retry_commands c JOIN task_runs previous ON previous.id=c.expected_run_id AND previous.task_id=c.task_id
          WHERE c.task_id=NEW.id AND c.actor_user_id=NEW.execution_user_id AND c.run_id=latest.id
          AND latest.status='queued' AND previous.status='failed' AND previous.attempt::bigint+1=latest.attempt
        ) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task retry requires a new Run and its immutable receipt';
        END IF;
        IF latest.id IS NULL OR latest.status<>NEW.status THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Task state must match its current Run';
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
  `CREATE OR REPLACE FUNCTION protect_task_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE parent tasks%ROWTYPE; latest task_runs%ROWTYPE;
    BEGIN
      SELECT t.* INTO parent FROM tasks t WHERE t.id=NEW.task_id FOR UPDATE;
      SELECT r.* INTO latest FROM task_runs r WHERE r.task_id=NEW.task_id ORDER BY r.attempt DESC LIMIT 1;
      IF TG_OP='INSERT' THEN
        IF parent.id IS NULL OR NEW.status<>'queued' OR NEW.created_at<parent.created_at
          OR NOT ((NEW.attempt=1 AND latest.id IS NULL AND parent.status='queued')
            OR (latest.id IS NOT NULL AND parent.status='failed' AND latest.status='failed'
              AND NEW.attempt::bigint=latest.attempt::bigint+1 AND NEW.created_at>=latest.finished_at)) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='new Task Run must be the next queued attempt';
        END IF;
      ELSE
        IF ROW(NEW.id,NEW.task_id,NEW.attempt,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.task_id,OLD.attempt,OLD.created_at)
          OR NOT ((OLD.status='queued' AND NEW.status IN ('running','failed'))
            OR (OLD.status='running' AND NEW.status IN ('completed','failed'))) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Run identity and terminal state are immutable';
        END IF;
        IF parent.id IS NULL OR parent.status<>OLD.status OR latest.id<>OLD.id THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='only the current Task Run can advance';
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
  `CREATE FUNCTION protect_task_retry_command() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.idempotency_key !~ '^[!-~]{1,128}$' OR NOT EXISTS (
        SELECT 1 FROM tasks t JOIN task_runs previous ON previous.task_id=t.id AND previous.id=NEW.expected_run_id
        JOIN task_runs next_run ON next_run.task_id=t.id AND next_run.id=NEW.run_id
        WHERE t.id=NEW.task_id AND t.execution_user_id=NEW.actor_user_id AND t.status='failed'
        AND previous.status='failed' AND next_run.status='queued'
        AND next_run.attempt::bigint=previous.attempt::bigint+1 AND next_run.created_at=NEW.created_at
        AND NOT EXISTS (SELECT 1 FROM task_runs later WHERE later.task_id=t.id AND later.attempt>next_run.attempt)
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='retry receipt must identify its original human and consecutive attempts';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER task_retry_commands_protected BEFORE INSERT ON task_retry_commands
    FOR EACH ROW EXECUTE FUNCTION protect_task_retry_command()`,
  `CREATE TRIGGER task_retry_commands_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON task_retry_commands
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION require_current_task_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE target UUID; parent tasks%ROWTYPE; latest task_runs%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='tasks' THEN target:=NEW.id; ELSE target:=NEW.task_id; END IF;
      SELECT t.* INTO parent FROM tasks t WHERE t.id=target;
      SELECT r.* INTO latest FROM task_runs r WHERE r.task_id=target ORDER BY r.attempt DESC LIMIT 1;
      IF parent.id IS NULL OR latest.id IS NULL OR parent.status<>latest.status
        OR (latest.attempt>1 AND NOT EXISTS (SELECT 1 FROM task_retry_commands c
          WHERE c.task_id=target AND c.run_id=latest.id AND c.actor_user_id=parent.execution_user_id)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Task, current Run and retry receipt must commit together';
      END IF;
      RETURN NULL;
    END;
    $$`,
  `CREATE CONSTRAINT TRIGGER tasks_current_run_required AFTER INSERT OR UPDATE ON tasks
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_current_task_run()`,
  `CREATE CONSTRAINT TRIGGER task_runs_current_run_required AFTER INSERT OR UPDATE ON task_runs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_current_task_run()`,
  `CREATE CONSTRAINT TRIGGER task_retry_commands_current_run_required AFTER INSERT ON task_retry_commands
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_current_task_run()`,
] as const;

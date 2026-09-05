// Repeatable overlay after 0023. It does not consume a ledger number (0024 is
// reserved for MEM-02) and does not rewrite published 0022/0023 statement lists.
// migrateDatabase reapplies these CREATE OR REPLACE bodies whenever 0023 is in
// the requested target so already-applied databases pick up automatic-attempt
// recognition. Human task_retry_commands receipts and immutability stay required.

export const COL10_AUTOMATIC_ATTEMPT_REQUIRES_VERSION = '0023_task_tree_cancellation';

export const COL10_AUTOMATIC_ATTEMPT_POSTGRES_GUARDS = [
  `CREATE OR REPLACE FUNCTION protect_task() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE latest task_runs%ROWTYPE;
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF NEW.status<>'cancelled' AND NOT lock_task_ancestry(NEW.id) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='cancelled Task ancestry cannot advance';
        END IF;
        IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')
          OR NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','cancelled'))
            OR (OLD.status='running' AND NEW.status IN ('completed','failed','cancelled'))
            OR (OLD.status='failed' AND NEW.status='queued')) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task identity and completed/cancelled state are immutable';
        END IF;
        SELECT r.* INTO latest FROM task_runs r WHERE r.task_id=NEW.id ORDER BY r.attempt DESC LIMIT 1;
        IF OLD.status='failed' AND NEW.status='queued' AND NOT EXISTS (
          SELECT 1 FROM task_retry_commands c JOIN task_runs previous ON previous.id=c.expected_run_id AND previous.task_id=c.task_id
          WHERE c.task_id=NEW.id AND c.actor_user_id=NEW.execution_user_id AND c.run_id=latest.id
          AND latest.status='queued' AND previous.status='failed' AND previous.attempt::bigint+1=latest.attempt
        ) AND NOT EXISTS (
          SELECT 1 FROM audit_events a
          JOIN task_runs previous ON previous.task_id=NEW.id AND previous.id::text=a.metadata->>'sourceRunId'
          WHERE a.event_type='task.queued' AND a.actor_user_id=NEW.execution_user_id
          AND a.metadata->>'taskId'=NEW.id::text AND a.metadata->>'runId'=latest.id::text
          AND a.metadata->>'origin' IN ('provider_retry','model_fallback')
          AND latest.status='queued' AND previous.status='failed'
          AND previous.attempt::bigint+1=latest.attempt
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
      IF NEW.status<>'cancelled' AND NOT lock_task_ancestry(NEW.task_id) THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='cancelled Task ancestry cannot create or advance a Run';
      END IF;
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
          OR NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','cancelled'))
            OR (OLD.status='running' AND NEW.status IN ('completed','failed','cancelled'))) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Run identity and terminal state are immutable';
        END IF;
        IF parent.id IS NULL OR parent.status<>OLD.status OR latest.id<>OLD.id THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='only the current Task Run can advance';
        END IF;
        IF NEW.status='cancelled' AND (
          ROW(NEW.started_at,NEW.claim_token,NEW.deadline_at,NEW.provider_scope_kind,
            NEW.provider_scope_id,NEW.connection_id,NEW.connection_revision,NEW.protocol,NEW.model_id)
            IS DISTINCT FROM ROW(OLD.started_at,OLD.claim_token,OLD.deadline_at,OLD.provider_scope_kind,
              OLD.provider_scope_id,OLD.connection_id,OLD.connection_revision,OLD.protocol,OLD.model_id)
          OR
          ROW(NEW.input_tokens,NEW.output_tokens,NEW.error_code,NEW.output_event_id) IS DISTINCT FROM
            ROW(OLD.input_tokens,OLD.output_tokens,OLD.error_code,OLD.output_event_id)
          OR NOT EXISTS (SELECT 1 FROM task_run_cancellations m JOIN task_cancel_commands c ON c.id=m.command_id
            WHERE m.run_id=NEW.id AND m.previous_status=OLD.status AND m.cancelled_at=NEW.finished_at
            AND c.cancelled_at=NEW.finished_at)) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cancelled Run requires its exact command marker, retained claim and usage';
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
          AND ((NEW.provider_scope_kind='personal' AND NEW.provider_scope_id=t.execution_user_id)
            OR (NEW.provider_scope_kind='workspace' AND NEW.provider_scope_id=t.workspace_id))
          AND (
            (
              v.configuration->'modelBinding'->'scope'->>'kind'=NEW.provider_scope_kind
              AND v.configuration->'modelBinding'->'scope'->>'id'=NEW.provider_scope_id::text
              AND v.configuration->'modelBinding'->>'connectionId'=NEW.connection_id::text
              AND v.configuration->'modelBinding'->>'modelId'=NEW.model_id
            )
            OR (
              EXISTS (
                SELECT 1 FROM audit_events a
                WHERE a.event_type='task.queued' AND a.metadata->>'runId'=NEW.id::text
                  AND a.metadata->>'taskId'=t.id::text
                  AND a.metadata->>'origin' IN ('provider_retry','model_fallback')
                  AND a.metadata->'binding'->'scope'->>'kind'=NEW.provider_scope_kind
                  AND a.metadata->'binding'->'scope'->>'id'=NEW.provider_scope_id::text
                  AND a.metadata->'binding'->>'connectionId'=NEW.connection_id::text
                  AND a.metadata->'binding'->>'modelId'=NEW.model_id
              )
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(v.configuration->'fallbackBindings','[]'::jsonb)) fb
                WHERE fb->'scope'->>'kind'=NEW.provider_scope_kind
                  AND fb->'scope'->>'id'=NEW.provider_scope_id::text
                  AND fb->>'connectionId'=NEW.connection_id::text
                  AND fb->>'modelId'=NEW.model_id
              )
            )
          )) THEN
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
  `CREATE OR REPLACE FUNCTION require_current_task_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE target UUID; parent tasks%ROWTYPE; latest task_runs%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='tasks' THEN target:=NEW.id; ELSE target:=NEW.task_id; END IF;
      SELECT t.* INTO parent FROM tasks t WHERE t.id=target;
      SELECT r.* INTO latest FROM task_runs r WHERE r.task_id=target ORDER BY r.attempt DESC LIMIT 1;
      IF parent.id IS NULL OR latest.id IS NULL OR parent.status<>latest.status
        OR (latest.attempt>1 AND NOT EXISTS (SELECT 1 FROM task_retry_commands c
          WHERE c.task_id=target AND c.run_id=latest.id AND c.actor_user_id=parent.execution_user_id)
          AND NOT EXISTS (
            SELECT 1 FROM audit_events a
            JOIN task_runs previous ON previous.task_id=target AND previous.id::text=a.metadata->>'sourceRunId'
            WHERE a.event_type='task.queued' AND a.actor_user_id=parent.execution_user_id
            AND a.metadata->>'taskId'=target::text AND a.metadata->>'runId'=latest.id::text
            AND a.metadata->>'origin' IN ('provider_retry','model_fallback')
            AND previous.status='failed' AND previous.attempt::bigint+1=latest.attempt
          )) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Task, current Run and retry receipt must commit together';
      END IF;
      RETURN NULL;
    END;
    $$`,
] as const;

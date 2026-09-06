// Only migration 0023 installs these guards; the historical migrations remain immutable.
// Native PostgreSQL verification is required for locks, triggers and rollback.
// PostgreSQL length counts Unicode scalars. Each supplementary scalar needs
// one extra UTF-16 unit; fixed C collation keeps the range locale-independent.
export const TASK_PARTIAL_LENGTH_SQL = `length(NEW.body)+length(regexp_replace(NEW.body COLLATE "C",'[^\u{10000}-\u{10ffff}]','','g'))`;
export const TASK_CANCELLATION_POSTGRES_GUARDS = [
  'ALTER TABLE tasks ADD CONSTRAINT task_root_retained FOREIGN KEY(root_task_id) REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED',
  `CREATE FUNCTION lock_task_ancestry(target UUID) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
    DECLARE root_id UUID; ancestor UUID;
    BEGIN
      SELECT root_task_id INTO STRICT root_id FROM tasks WHERE id=target;
      PERFORM id FROM tasks WHERE id=root_id FOR UPDATE;
      FOR ancestor IN WITH RECURSIVE chain AS (
        SELECT id,parent_task_id FROM tasks WHERE id=target
        UNION ALL SELECT t.id,t.parent_task_id FROM tasks t JOIN chain c ON t.id=c.parent_task_id
      ) SELECT id FROM chain ORDER BY id LOOP
        PERFORM id FROM tasks WHERE id=ancestor FOR UPDATE;
      END LOOP;
      RETURN NOT EXISTS (WITH RECURSIVE chain AS (
        SELECT id,parent_task_id,status FROM tasks WHERE id=target
        UNION ALL SELECT t.id,t.parent_task_id,t.status FROM tasks t JOIN chain c ON t.id=c.parent_task_id
      ) SELECT 1 FROM chain WHERE status='cancelled');
    END;
    $$`,
  `CREATE FUNCTION protect_task_tree() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE parent tasks%ROWTYPE;
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.root_task_id,NEW.parent_task_id,NEW.depth) IS DISTINCT FROM ROW(OLD.root_task_id,OLD.parent_task_id,OLD.depth) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task ancestry is immutable';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.parent_task_id IS NULL THEN
        IF NEW.root_task_id IS NULL THEN NEW.root_task_id:=NEW.id; END IF;
        IF NEW.root_task_id<>NEW.id OR NEW.depth<>0 THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='root Task must identify itself at depth zero';
        END IF;
      ELSE
        IF NEW.parent_task_id=NEW.id OR NOT lock_task_ancestry(NEW.parent_task_id) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='child Task requires uncancelled ancestry';
        END IF;
        SELECT * INTO STRICT parent FROM tasks WHERE id=NEW.parent_task_id;
        IF NEW.root_task_id<>parent.root_task_id OR NEW.depth::bigint<>parent.depth::bigint+1
          OR NEW.workspace_id<>parent.workspace_id OR NEW.conversation_id<>parent.conversation_id
          OR NEW.execution_user_id<>parent.execution_user_id OR NEW.created_at<parent.created_at
          OR NOT EXISTS (SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND group_id IS NOT NULL) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='child Task must retain its group, original human, root and depth';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$`,
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
  `CREATE TRIGGER tasks_protected BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION protect_task()`,
  `CREATE TRIGGER tasks_tree_protected BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION protect_task_tree()`,
  `CREATE FUNCTION protect_task_cancel_command() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE selected tasks%ROWTYPE; current_run task_runs%ROWTYPE; item UUID; active_count INTEGER;
    BEGIN
      PERFORM lock_task_ancestry(NEW.task_id);
      SELECT * INTO STRICT selected FROM tasks WHERE id=NEW.task_id;
      FOR item IN WITH RECURSIVE subtree AS (
        SELECT id FROM tasks WHERE id=NEW.task_id
        UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id
      ) SELECT id FROM subtree ORDER BY id LOOP
        PERFORM id FROM tasks WHERE id=item FOR UPDATE;
      END LOOP;
      FOR item IN WITH RECURSIVE subtree AS (
        SELECT id FROM tasks WHERE id=NEW.task_id
        UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id
      ) SELECT id FROM subtree ORDER BY id LOOP
        PERFORM id FROM task_runs WHERE task_id=item ORDER BY attempt DESC LIMIT 1 FOR UPDATE;
      END LOOP;
      SELECT * INTO STRICT current_run FROM task_runs WHERE task_id=NEW.task_id ORDER BY attempt DESC LIMIT 1;
      IF NEW.idempotency_key !~ '^[!-~]{1,128}$' OR NEW.root_task_id<>selected.root_task_id
        OR NEW.expected_run_id<>current_run.id OR NEW.attempt<>current_run.attempt
        OR selected.status<>current_run.status OR selected.status NOT IN ('queued','running','cancelled')
        OR NEW.created_at<NEW.cancelled_at OR NEW.cancelled_at<COALESCE(current_run.started_at,current_run.created_at)
        OR NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id=selected.workspace_id AND user_id=NEW.actor_user_id)
        OR NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id=selected.conversation_id AND (
          (c.group_id IS NULL AND c.creator_user_id=NEW.actor_user_id AND selected.execution_user_id=NEW.actor_user_id)
          OR (c.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM group_memberships m WHERE m.group_id=c.group_id
            AND m.user_id=NEW.actor_user_id AND (selected.execution_user_id=NEW.actor_user_id OR m.role IN ('owner','admin')))))) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cancellation receipt requires current scope, authority and exact Run';
      END IF;
      SELECT count(*) INTO active_count FROM (WITH RECURSIVE subtree AS (
        SELECT id,status FROM tasks WHERE id=NEW.task_id
        UNION ALL SELECT t.id,t.status FROM tasks t JOIN subtree s ON t.parent_task_id=s.id
      ) SELECT 1 FROM subtree WHERE status IN ('queued','running')) active;
      IF active_count<>NEW.affected_task_count OR NEW.affected_run_count<>active_count
        OR (selected.status='cancelled' AND (active_count<>0 OR NEW.cancelled_at<>current_run.finished_at)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cancellation receipt must cover every unfinished descendant';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE FUNCTION protect_task_run_cancellation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE command task_cancel_commands%ROWTYPE; target_run task_runs%ROWTYPE;
    BEGIN
      SELECT * INTO STRICT command FROM task_cancel_commands WHERE id=NEW.command_id;
      SELECT * INTO STRICT target_run FROM task_runs WHERE id=NEW.run_id FOR UPDATE;
      IF NEW.previous_status<>target_run.status OR target_run.status NOT IN ('queued','running')
        OR NEW.cancelled_at<>command.cancelled_at
        OR EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id=target_run.task_id AND r.attempt>target_run.attempt)
        OR NOT EXISTS (WITH RECURSIVE subtree AS (
          SELECT id FROM tasks WHERE id=command.task_id
          UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id
        ) SELECT 1 FROM subtree WHERE id=target_run.task_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Run cancellation marker must belong to its exact subtree command';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE FUNCTION require_cancelled_task_tree() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    DECLARE command task_cancel_commands%ROWTYPE; marker_count BIGINT;
    BEGIN
      IF TG_TABLE_NAME='task_cancel_commands' THEN
        SELECT * INTO STRICT command FROM task_cancel_commands WHERE id=NEW.id;
      ELSIF TG_TABLE_NAME='task_run_cancellations' THEN
        SELECT * INTO STRICT command FROM task_cancel_commands WHERE id=NEW.command_id;
      ELSE
        IF NEW.status<>'cancelled' THEN RETURN NULL; END IF;
        SELECT c.* INTO command FROM task_cancel_commands c JOIN task_run_cancellations m ON m.command_id=c.id WHERE m.run_id=NEW.id;
        IF command.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cancelled Run requires its retained command'; END IF;
      END IF;
      SELECT count(*) INTO marker_count FROM task_run_cancellations WHERE command_id=command.id;
      IF marker_count<>command.affected_run_count OR EXISTS (WITH RECURSIVE subtree AS (
        SELECT id,status FROM tasks WHERE id=command.task_id
        UNION ALL SELECT t.id,t.status FROM tasks t JOIN subtree s ON t.parent_task_id=s.id
      ) SELECT 1 FROM subtree WHERE status IN ('queued','running'))
        OR EXISTS (SELECT 1 FROM task_run_cancellations m JOIN task_runs r ON r.id=m.run_id JOIN tasks t ON t.id=r.task_id
          WHERE m.command_id=command.id AND (r.status<>'cancelled' OR t.status<>'cancelled' OR r.finished_at<>command.cancelled_at
            OR NOT EXISTS (SELECT 1 FROM task_run_delivery_receipts d WHERE d.run_id=r.id AND d.run_status='cancelled' AND d.conversation_id=t.conversation_id)
            OR (SELECT count(*) FROM audit_events a WHERE a.event_type='task.cancelled' AND a.actor_user_id=command.actor_user_id
              AND a.metadata->>'cancelCommandId'=command.id::text AND a.metadata->>'taskId'=t.id::text AND a.metadata->>'runId'=r.id::text)<>1)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cancelled subtree, markers, audit and delivery must commit together';
      END IF;
      RETURN NULL;
    END;
    $$`,
  `CREATE TRIGGER task_cancel_command_protected BEFORE INSERT ON task_cancel_commands FOR EACH ROW EXECUTE FUNCTION protect_task_cancel_command()`,
  `CREATE TRIGGER task_run_cancellation_protected BEFORE INSERT ON task_run_cancellations FOR EACH ROW EXECUTE FUNCTION protect_task_run_cancellation()`,
  `CREATE TRIGGER task_cancel_commands_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON task_cancel_commands FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE TRIGGER task_run_cancellations_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON task_run_cancellations FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE CONSTRAINT TRIGGER task_cancel_command_complete AFTER INSERT ON task_cancel_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cancelled_task_tree()`,
  `CREATE CONSTRAINT TRIGGER task_run_cancellation_complete AFTER INSERT ON task_run_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cancelled_task_tree()`,
  `CREATE CONSTRAINT TRIGGER task_run_cancelled_complete AFTER UPDATE ON task_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cancelled_task_tree()`,
  `CREATE FUNCTION protect_task_partial_output() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE target UUID; selected task_runs%ROWTYPE; previous_end INTEGER; previous_body TEXT;
    BEGIN
      target:=CASE WHEN TG_OP='DELETE' THEN OLD.run_id ELSE NEW.run_id END;
      SELECT * INTO STRICT selected FROM task_runs WHERE id=target;
      IF TG_OP='DELETE' THEN
        IF selected.status<>'completed' OR NOT EXISTS (SELECT 1 FROM conversation_events WHERE id=selected.output_event_id AND bot_run_id=selected.id AND event_type='bot.message.created') THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='only canonical completed output can replace a Run partial';
        END IF;
        RETURN OLD;
      END IF;
      IF NOT lock_task_ancestry(selected.task_id) THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='cancelled ancestry cannot publish partial output'; END IF;
      SELECT * INTO STRICT selected FROM task_runs WHERE id=target FOR UPDATE;
      previous_end:=CASE WHEN TG_OP='UPDATE' THEN OLD.end_byte ELSE 0 END;
      previous_body:=CASE WHEN TG_OP='UPDATE' THEN OLD.body ELSE '' END;
      IF ${TASK_PARTIAL_LENGTH_SQL}>32000 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Run partial exceeds 32000 UTF-16 code units';
      END IF;
      IF selected.status<>'running' OR selected.deadline_at<=clock_timestamp()
        OR (TG_OP='UPDATE' AND NEW.run_id<>OLD.run_id)
        OR EXISTS (SELECT 1 FROM task_runs WHERE task_id=selected.task_id AND attempt>selected.attempt)
        OR octet_length(NEW.body)<>NEW.end_byte
        OR NOT EXISTS (SELECT 1 FROM task_run_streams WHERE run_id=target AND delivered_bytes=NEW.end_byte)
        OR NOT EXISTS (SELECT 1 FROM conversation_delivery_events WHERE run_id=target AND event_type='assistant.delta'
          AND start_byte=previous_end AND end_byte=NEW.end_byte AND previous_body||delta_text=NEW.body AND occurred_at=NEW.updated_at) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Run partial requires its exact contiguous live delta and progress';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE FUNCTION require_task_partial_checkpoint() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE selected task_runs%ROWTYPE; byte_count INTEGER;
    BEGIN
      SELECT * INTO STRICT selected FROM task_runs WHERE id=NEW.run_id;
      SELECT delivered_bytes INTO STRICT byte_count FROM task_run_streams WHERE run_id=NEW.run_id;
      IF byte_count>0 AND NOT EXISTS (SELECT 1 FROM task_run_partial_outputs WHERE run_id=NEW.run_id AND end_byte=byte_count)
        AND NOT (selected.status='completed' AND EXISTS (SELECT 1 FROM conversation_events WHERE id=selected.output_event_id AND bot_run_id=selected.id AND event_type='bot.message.created')) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='accepted delta progress must retain its complete Run checkpoint';
      END IF;
      RETURN NULL;
    END;
    $$`,
  `CREATE FUNCTION fence_cancelled_task_publication() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE target UUID; selected task_runs%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='conversation_events' THEN
        IF NEW.event_type<>'bot.message.created' THEN RETURN NEW; END IF;
        target:=NEW.bot_run_id;
      ELSIF TG_TABLE_NAME='conversation_delivery_events' THEN
        IF NEW.event_type<>'assistant.delta' THEN RETURN NEW; END IF;
        target:=NEW.run_id;
      ELSE target:=NEW.run_id;
      END IF;
      SELECT * INTO STRICT selected FROM task_runs WHERE id=target;
      IF NOT lock_task_ancestry(selected.task_id) THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='cancelled ancestry cannot publish'; END IF;
      SELECT * INTO STRICT selected FROM task_runs WHERE id=target FOR UPDATE;
      IF selected.status<>'running' OR selected.deadline_at<=clock_timestamp()
        OR NOT EXISTS (SELECT 1 FROM tasks WHERE id=selected.task_id AND status='running')
        OR EXISTS (SELECT 1 FROM task_runs WHERE task_id=selected.task_id AND attempt>selected.attempt) THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='only the current live Run can publish';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER task_partial_output_protected BEFORE INSERT OR UPDATE OR DELETE ON task_run_partial_outputs FOR EACH ROW EXECUTE FUNCTION protect_task_partial_output()`,
  `CREATE TRIGGER task_partial_output_no_truncate BEFORE TRUNCATE ON task_run_partial_outputs FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE CONSTRAINT TRIGGER task_partial_checkpoint_required AFTER INSERT OR UPDATE ON task_run_streams DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_task_partial_checkpoint()`,
  `CREATE TRIGGER conversation_bot_output_cancel_fence BEFORE INSERT ON conversation_events FOR EACH ROW EXECUTE FUNCTION fence_cancelled_task_publication()`,
  `CREATE TRIGGER conversation_delta_cancel_fence BEFORE INSERT ON conversation_delivery_events FOR EACH ROW EXECUTE FUNCTION fence_cancelled_task_publication()`,
  `CREATE TRIGGER task_stream_cancel_fence BEFORE INSERT OR UPDATE ON task_run_streams FOR EACH ROW EXECUTE FUNCTION fence_cancelled_task_publication()`,
] as const;

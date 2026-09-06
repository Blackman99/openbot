// Repeatable overlays after 0036/0037. They do not consume a ledger number and
// do not rewrite published 0017/0022/0023/0033/0034/0035 statement lists.
import { COL12_LIMITS_REQUIRES_VERSION } from './execution-limit-schema.js';
import { COL12_ENFORCEMENT_REQUIRES_VERSION } from './execution-limit-enforcement-schema.js';

export { COL12_LIMITS_REQUIRES_VERSION, COL12_ENFORCEMENT_REQUIRES_VERSION };

export const COL12_LIMITS_POSTGRES_GUARDS = [
  `CREATE OR REPLACE FUNCTION protect_task_execution_limit_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task execution limit snapshots are immutable';
      END IF;
      RETURN NEW;
    END;
    $$`,
  'DROP TRIGGER IF EXISTS task_execution_limit_snapshots_protected ON task_execution_limit_snapshots',
  `CREATE TRIGGER task_execution_limit_snapshots_protected BEFORE INSERT OR UPDATE OR DELETE ON task_execution_limit_snapshots
    FOR EACH ROW EXECUTE FUNCTION protect_task_execution_limit_snapshot()`,
  'DROP TRIGGER IF EXISTS task_execution_limit_snapshots_retained ON task_execution_limit_snapshots',
  `CREATE TRIGGER task_execution_limit_snapshots_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON task_execution_limit_snapshots
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
] as const;

export const COL12_ENFORCEMENT_POSTGRES_GUARDS = [
  `CREATE OR REPLACE FUNCTION lock_task_ancestry(target UUID, allow_paused BOOLEAN) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
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
      ) SELECT 1 FROM chain WHERE status='cancelled'
        OR (status IN ('paused','waiting_budget') AND NOT (allow_paused AND id=target AND status='paused')));
    END;
    $$`,
  `CREATE OR REPLACE FUNCTION protect_task() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE latest task_runs%ROWTYPE;
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF NEW.status<>'cancelled' AND NEW.status<>'paused' AND NEW.status<>'waiting_budget' AND NOT lock_task_ancestry(NEW.id, OLD.status='paused' AND NEW.status='queued') THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='cancelled Task ancestry cannot advance';
        END IF;
        IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')
          OR NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','cancelled','paused','waiting_budget'))
            OR (OLD.status='running' AND NEW.status IN ('completed','failed','cancelled','paused'))
            OR (OLD.status='failed' AND NEW.status IN ('queued','waiting_budget'))
            OR (OLD.status='paused' AND NEW.status IN ('queued','waiting_budget'))) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task identity and completed/cancelled state are immutable';
        END IF;
        SELECT r.* INTO latest FROM task_runs r WHERE r.task_id=NEW.id ORDER BY r.attempt DESC LIMIT 1;
        IF OLD.status='failed' AND NEW.status='queued' AND NOT EXISTS (
          SELECT 1 FROM task_retry_commands c JOIN task_runs previous ON previous.id=c.expected_run_id AND previous.task_id=c.task_id
          WHERE c.task_id=NEW.id AND c.actor_user_id=NEW.execution_user_id AND c.run_id=latest.id
          AND latest.status='queued' AND previous.status='failed' AND previous.attempt::bigint+1=latest.attempt
        ) AND NOT (
          latest.status='queued'
          AND (
            task_has_automatic_continuation_receipt(NEW.id, latest.id, NEW.execution_user_id)
            OR (
              COALESCE(task_queued_audit_metadata(latest.id)->>'origin','')
                IN ('provider_retry','model_fallback','worker_recovery')
              AND EXISTS (
                SELECT 1 FROM task_runs previous
                WHERE previous.task_id=NEW.id
                  AND previous.id::text=task_queued_audit_metadata(latest.id)->>'sourceRunId'
                  AND previous.status='failed'
                  AND previous.attempt::bigint+1=latest.attempt
              )
            )
          )
        ) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task retry requires a new Run and its immutable receipt';
        END IF;
        IF OLD.status='paused' AND NEW.status='queued' AND NOT (
          latest.status='queued'
          AND (
            task_has_manual_resume_receipt(NEW.id, latest.id, NEW.execution_user_id)
            OR (
              COALESCE(task_queued_audit_metadata(latest.id)->>'origin','')='manual_resume'
              AND EXISTS (
                SELECT 1 FROM task_runs previous
                WHERE previous.task_id=NEW.id
                  AND previous.id::text=task_queued_audit_metadata(latest.id)->>'sourceRunId'
                  AND previous.status='paused'
                  AND previous.attempt::bigint+1=latest.attempt
              )
            )
          )
        ) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task resume requires a new Run and its immutable receipt';
        END IF;
        IF latest.id IS NULL OR (NEW.status<>'waiting_budget' AND latest.status<>NEW.status) THEN
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
  `CREATE OR REPLACE FUNCTION require_current_task_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE target UUID; parent tasks%ROWTYPE; latest task_runs%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='tasks' THEN target:=NEW.id; ELSE target:=NEW.task_id; END IF;
      SELECT t.* INTO parent FROM tasks t WHERE t.id=target;
      SELECT r.* INTO latest FROM task_runs r WHERE r.task_id=target ORDER BY r.attempt DESC LIMIT 1;
      IF parent.id IS NULL OR latest.id IS NULL
        OR (parent.status<>'waiting_budget' AND parent.status<>latest.status)
        OR (latest.attempt>1 AND NOT EXISTS (SELECT 1 FROM task_retry_commands c
          WHERE c.task_id=target AND c.run_id=latest.id AND c.actor_user_id=parent.execution_user_id)
          AND NOT task_has_automatic_continuation_receipt(target, latest.id, parent.execution_user_id)
          AND NOT task_has_manual_resume_receipt(target, latest.id, parent.execution_user_id)
          AND COALESCE(task_queued_audit_metadata(latest.id)->>'origin','')
            NOT IN ('manual_resume','provider_retry','model_fallback','worker_recovery')) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Task, current Run and retry receipt must commit together';
      END IF;
      RETURN NULL;
    END;
    $$`,
  `CREATE OR REPLACE FUNCTION protect_conversation_delivery() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE target UUID; tail BIGINT; retained_floor BIGINT;
    BEGIN
      IF TG_OP='UPDATE' THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='delivery event is immutable';
      END IF;
      target := CASE WHEN TG_OP='DELETE' THEN OLD.conversation_id ELSE NEW.conversation_id END;
      SELECT last_sequence INTO STRICT tail FROM conversations WHERE id=target;
      SELECT floor INTO STRICT retained_floor FROM conversation_delivery_state WHERE conversation_id=target;
      IF TG_OP='DELETE' THEN
        IF OLD.sequence>retained_floor THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='delivery deletion must reclaim an advanced prefix';
        END IF;
        RETURN OLD;
      END IF;
      IF NEW.sequence<>tail OR NEW.sequence<=retained_floor
        OR NEW.byte_size<2048+octet_length(COALESCE(NEW.delta_text,''))+octet_length(COALESCE(NEW.execution::text,'')) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery requires its allocated sequence and bounded size';
      END IF;
      IF NEW.ledger_event_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_events e WHERE e.id=NEW.ledger_event_id AND e.conversation_id=target AND e.sequence=NEW.sequence
          AND ((NEW.event_type='message.changed' AND e.message_id IS NOT NULL)
            OR (NEW.event_type='conversation.invalidated' AND e.event_type IN ('bot.joined','bot.removed','task.limit.warning')))) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery reference must name its own ledger event';
      END IF;
      IF NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=NEW.run_id AND t.conversation_id=target) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery Run must belong to its conversation';
      END IF;
      IF NEW.event_type='task.run.updated' AND NOT EXISTS (
        SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=NEW.run_id
          AND NEW.execution->>'taskId'=t.id::text AND NEW.execution->>'runId'=r.id::text
          AND NEW.execution->>'attempt'=r.attempt::text AND NEW.execution->>'runStatus'=r.status AND NEW.run_status=r.status
          AND NEW.execution->>'taskStatus'=r.status AND t.status=r.status) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery state must match its committed Run';
      END IF;
      IF NEW.event_type='assistant.delta' AND (octet_length(NEW.delta_text)>4096 OR octet_length(NEW.delta_text)<>NEW.end_byte-NEW.start_byte OR NOT EXISTS (
        SELECT 1 FROM task_runs r JOIN task_run_streams s ON s.run_id=r.id
        WHERE r.id=NEW.run_id AND r.status='running' AND r.deadline_at>clock_timestamp() AND s.delivered_bytes=NEW.start_byte)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delta requires its live claim and contiguous byte offset';
      END IF;
      RETURN NEW;
    END;
    $$`,
] as const;

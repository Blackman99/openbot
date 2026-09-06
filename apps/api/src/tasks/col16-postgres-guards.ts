// Repeatable overlay after 0044. It does not consume a ledger number and does
// not rewrite published 0017/0022/0035/0037/0040/0043 statement lists. Applied
// last so COL-14 does not overwrite Lead-transfer receipts.

import { COL16_HANDOFF_REQUIRES_VERSION } from './handoff-schema.js';

export { COL16_HANDOFF_REQUIRES_VERSION };

export const COL16_HANDOFF_POSTGRES_GUARDS = [
  `CREATE OR REPLACE FUNCTION task_has_handoff_receipt(target uuid, run_id uuid, actor uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM audit_events a
    JOIN task_runs previous ON previous.task_id=target AND previous.id::text=a.metadata->>'sourceRunId'
    JOIN task_runs next_run ON next_run.id=run_id AND next_run.task_id=target
    JOIN task_handoffs h ON h.task_id=target AND h.source_run_id=previous.id
    WHERE a.event_type='task.queued'
      AND a.actor_user_id=actor
      AND a.metadata->>'taskId'=target::text
      AND a.metadata->>'runId'=run_id::text
      AND a.metadata->>'origin'='handoff'
      AND previous.status='failed'
      AND previous.error_code='handed_off'
      AND previous.attempt::bigint+1=next_run.attempt
  )
$$`,
  'REVOKE ALL ON FUNCTION task_has_handoff_receipt(uuid,uuid,uuid) FROM PUBLIC',
  `CREATE OR REPLACE FUNCTION task_has_handoff_lead_change(target uuid, bot uuid, version uuid, grant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM task_handoffs h
    WHERE h.task_id=target
      AND h.target_bot_id=bot
      AND h.target_bot_version_id=version
      AND h.target_grant_id=grant_id
  )
$$`,
  'REVOKE ALL ON FUNCTION task_has_handoff_lead_change(uuid,uuid,uuid,uuid) FROM PUBLIC',
  `CREATE OR REPLACE FUNCTION protect_task() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE latest task_runs%ROWTYPE;
    DECLARE identity_stable boolean;
    DECLARE lead_changed boolean;
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF NEW.status<>'cancelled' AND NEW.status<>'paused' AND NEW.status<>'waiting_budget' AND NEW.status<>'waiting_child' AND NOT lock_task_ancestry(NEW.id, (OLD.status='paused' OR OLD.status='waiting_budget' OR OLD.status='waiting_child') AND NEW.status='queued') THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='cancelled Task ancestry cannot advance';
        END IF;
        identity_stable := (to_jsonb(NEW)-'status'-'bot_id'-'bot_version_id'-'group_grant_id')
          IS NOT DISTINCT FROM (to_jsonb(OLD)-'status'-'bot_id'-'bot_version_id'-'group_grant_id');
        lead_changed := ROW(NEW.bot_id,NEW.bot_version_id,NEW.group_grant_id)
          IS DISTINCT FROM ROW(OLD.bot_id,OLD.bot_version_id,OLD.group_grant_id);
        IF NOT identity_stable
          OR (lead_changed AND NOT (
            OLD.status='failed' AND NEW.status='failed'
            AND task_has_handoff_lead_change(NEW.id, NEW.bot_id, NEW.bot_version_id, NEW.group_grant_id)
          ))
          OR NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','cancelled','paused','waiting_budget'))
            OR (OLD.status='running' AND NEW.status IN ('completed','failed','cancelled','paused','waiting_child'))
            OR (OLD.status='failed' AND NEW.status IN ('queued','waiting_budget'))
            OR (OLD.status='failed' AND NEW.status='failed' AND lead_changed)
            OR (OLD.status='paused' AND NEW.status IN ('queued','waiting_budget'))
            OR (OLD.status='waiting_budget' AND NEW.status='queued')
            OR (OLD.status='waiting_child' AND NEW.status IN ('queued','cancelled'))) THEN
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
            OR task_has_handoff_receipt(NEW.id, latest.id, NEW.execution_user_id)
            OR (
              COALESCE(task_queued_audit_metadata(latest.id)->>'origin','')
                IN ('provider_retry','model_fallback','worker_recovery','handoff')
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
        IF OLD.status='waiting_budget' AND NEW.status='queued' AND NOT (
          latest.status='queued'
          AND EXISTS (SELECT 1 FROM task_execution_limit_grants g WHERE g.task_id=NEW.id)
          AND (
            task_has_budget_grant_receipt(NEW.id, latest.id, NEW.execution_user_id)
            OR (
              COALESCE(task_queued_audit_metadata(latest.id)->>'origin','')='budget_grant'
              AND EXISTS (
                SELECT 1 FROM task_runs previous
                WHERE previous.task_id=NEW.id
                  AND previous.id::text=task_queued_audit_metadata(latest.id)->>'sourceRunId'
                  AND previous.status IN ('failed','paused')
                  AND previous.attempt::bigint+1=latest.attempt
              )
            )
            OR COALESCE(task_queued_audit_metadata(latest.id)->>'origin','')<>'budget_grant'
          )
        ) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task budget grant requires a new Run and its immutable receipt';
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
        IF OLD.status='waiting_child' AND NEW.status='queued' AND NOT (
          latest.status='queued'
          AND (
            task_has_child_result_receipt(NEW.id, latest.id, NEW.execution_user_id)
            OR (
              COALESCE(task_queued_audit_metadata(latest.id)->>'origin','')='child_result'
              AND EXISTS (
                SELECT 1 FROM task_runs previous
                WHERE previous.task_id=NEW.id
                  AND previous.id::text=task_queued_audit_metadata(latest.id)->>'sourceRunId'
                  AND previous.status='waiting_child'
                  AND previous.attempt::bigint+1=latest.attempt
              )
            )
          )
        ) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task child result requires a new Run and its immutable receipt';
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
            AND g.conversation_id=c.id AND g.bot_id=NEW.bot_id
            AND (e.sequence>=g.lower_bound OR EXISTS (
              SELECT 1 FROM task_handoffs h WHERE h.task_id=NEW.id AND h.target_grant_id=NEW.group_grant_id
            )))))) THEN
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
          AND NOT task_has_budget_grant_receipt(target, latest.id, parent.execution_user_id)
          AND NOT task_has_child_result_receipt(target, latest.id, parent.execution_user_id)
          AND NOT task_has_handoff_receipt(target, latest.id, parent.execution_user_id)
          AND COALESCE(task_queued_audit_metadata(latest.id)->>'origin','')
            NOT IN ('manual_resume','budget_grant','provider_retry','model_fallback','worker_recovery','child_result','handoff')) THEN
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
            OR (NEW.event_type='conversation.invalidated' AND e.event_type IN ('bot.joined','bot.removed','task.limit.warning','task.handoff')))) THEN
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

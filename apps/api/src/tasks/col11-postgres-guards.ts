// Repeatable overlay after 0035. It does not consume a ledger number and does
// not rewrite published 0022/0023/0033/0034/COL-08 statement lists. migrateDatabase
// reapplies these CREATE OR REPLACE bodies whenever 0035 is in the requested
// target so already-applied databases recognize worker_recovery receipts and
// fence expired claims. Runtime still cannot SELECT audit_events; helpers are
// SECURITY DEFINER.

import { COL11_RECOVERY_REQUIRES_VERSION } from './recovery-schema.js';

export { COL11_RECOVERY_REQUIRES_VERSION };

export const COL11_RECOVERY_POSTGRES_GUARDS = [
  `CREATE OR REPLACE FUNCTION task_has_automatic_continuation_receipt(target uuid, run_id uuid, actor uuid)
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
    WHERE a.event_type='task.queued'
      AND a.actor_user_id=actor
      AND a.metadata->>'taskId'=target::text
      AND a.metadata->>'runId'=run_id::text
      AND a.metadata->>'origin' IN ('provider_retry','model_fallback','worker_recovery')
      AND previous.status='failed'
      AND previous.attempt::bigint+1=next_run.attempt
  )
$$`,
  'REVOKE ALL ON FUNCTION task_has_automatic_continuation_receipt(uuid,uuid,uuid) FROM PUBLIC',
  `CREATE OR REPLACE FUNCTION protect_task_run_lease() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task Run leases cannot be deleted';
      END IF;
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.run_id,NEW.claim_token,NEW.process_instance_id,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.run_id,OLD.claim_token,OLD.process_instance_id,OLD.created_at) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task Run lease identity is immutable';
        END IF;
        IF NEW.heartbeat_at<OLD.heartbeat_at OR NEW.expires_at<NEW.heartbeat_at THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Task Run lease renewal must move heartbeat forward';
        END IF;
        IF OLD.expires_at<=clock_timestamp()
          AND ROW(NEW.heartbeat_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.heartbeat_at,OLD.expires_at) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='expired Task Run lease cannot be renewed';
        END IF;
      ELSIF NOT EXISTS (
        SELECT 1 FROM task_runs r
        WHERE r.id=NEW.run_id AND r.status='running' AND r.claim_token=NEW.claim_token
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Task Run lease requires its current claim';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE OR REPLACE FUNCTION protect_task_run_recovery_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Task Run recovery receipts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE OR REPLACE FUNCTION fence_expired_claim_publication() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.status='running' THEN
        IF NEW.status='completed'
          OR (NEW.status='failed' AND NEW.error_code NOT IN ('worker_interrupted','execution_timeout','worker_stopped')) THEN
          IF NOT EXISTS (
            SELECT 1 FROM task_run_leases l
            WHERE l.run_id=NEW.id AND l.claim_token=NEW.claim_token AND l.expires_at>clock_timestamp()
          ) THEN
            RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='expired Task Run lease cannot publish';
          END IF;
        ELSIF NEW.status='failed' AND NEW.error_code='worker_interrupted' THEN
          IF EXISTS (
            SELECT 1 FROM task_run_leases l
            WHERE l.run_id=NEW.id AND l.claim_token=NEW.claim_token AND l.expires_at>clock_timestamp()
          ) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='worker interruption requires an expired lease';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$`,
  'DROP TRIGGER IF EXISTS task_run_leases_protected ON task_run_leases',
  `CREATE TRIGGER task_run_leases_protected BEFORE INSERT OR UPDATE OR DELETE ON task_run_leases
    FOR EACH ROW EXECUTE FUNCTION protect_task_run_lease()`,
  'DROP TRIGGER IF EXISTS task_run_leases_retained ON task_run_leases',
  `CREATE TRIGGER task_run_leases_retained BEFORE DELETE OR TRUNCATE ON task_run_leases
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  'DROP TRIGGER IF EXISTS task_run_recovery_receipts_protected ON task_run_recovery_receipts',
  `CREATE TRIGGER task_run_recovery_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON task_run_recovery_receipts
    FOR EACH ROW EXECUTE FUNCTION protect_task_run_recovery_receipt()`,
  'DROP TRIGGER IF EXISTS task_run_recovery_receipts_retained ON task_run_recovery_receipts',
  `CREATE TRIGGER task_run_recovery_receipts_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON task_run_recovery_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  'DROP TRIGGER IF EXISTS task_runs_lease_publication ON task_runs',
  `CREATE TRIGGER task_runs_lease_publication BEFORE UPDATE ON task_runs
    FOR EACH ROW EXECUTE FUNCTION fence_expired_claim_publication()`,
] as const;

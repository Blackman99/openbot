// Repeatable overlay after 0036. It does not consume a ledger number and does
// not rewrite published 0017/0022/0023/0033/0034/0035 statement lists.
import { COL12_LIMITS_REQUIRES_VERSION } from './execution-limit-schema.js';

export { COL12_LIMITS_REQUIRES_VERSION };

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

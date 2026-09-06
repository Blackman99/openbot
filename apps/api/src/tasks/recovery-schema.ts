// Migration 0035 follows 0034. Published 0017/0022/0023/0033/0034 statement
// lists stay unchanged. Crash recovery stores a separate lease and one
// immutable receipt per interrupted Run; it does not reopen a claim.
export const TASK_RECOVERY_SCHEMA_STATEMENTS = [
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_error_code_check',
  // pg-mem names the 0017 inline error_code CHECK this way; native PostgreSQL
  // uses task_runs_error_code_check and ignores this missing name.
  'ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_constraint_5',
  `ALTER TABLE task_runs ADD CONSTRAINT task_runs_error_code_check CHECK (
    error_code IS NULL OR error_code IN (
      'execution_forbidden','model_unavailable','provider_failed','execution_timeout',
      'output_limit','context_limit','worker_stopped','worker_interrupted'
    )
  )`,
  `CREATE TABLE task_run_leases (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    claim_token UUID NOT NULL,
    process_instance_id UUID,
    heartbeat_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (heartbeat_at>=created_at),
    CHECK (expires_at>=heartbeat_at)
  )`,
  `CREATE TABLE task_run_recovery_receipts (
    source_run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    chain_root_run_id UUID NOT NULL REFERENCES task_runs(id),
    interrupted_at TIMESTAMPTZ NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('queued_successor','stopped')),
    successor_run_id UUID REFERENCES task_runs(id),
    stop_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (
      (decision='queued_successor' AND successor_run_id IS NOT NULL AND successor_run_id<>source_run_id AND stop_reason IS NULL)
      OR (decision='stopped' AND successor_run_id IS NULL AND stop_reason IS NOT NULL AND stop_reason<>'')
    )
  )`,
] as const;

export const TASK_RECOVERY_POSTGRES_PREFLIGHT = [
  'LOCK TABLE tasks,task_runs IN ACCESS EXCLUSIVE MODE',
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM task_runs WHERE status='running') THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Stop new claims and drain legacy workers before migration 0035';
    END IF;
  END $$`,
] as const;

export const COL11_RECOVERY_REQUIRES_VERSION = '0035_task_run_recovery';

// Migration 0026 follows MEM-03 extraction-job ledger 0025.
export const CANDIDATE_SCHEMA_STATEMENTS = [
  `CREATE TABLE memory_candidates (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES task_runs(id),
    workspace_id UUID NOT NULL,
    normalized_fingerprint CHAR(64) NOT NULL,
    proposed_scope_kind TEXT NOT NULL CHECK(proposed_scope_kind IN ('group','bot','workspace')),
    proposed_scope_id UUID NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
    confidence DOUBLE PRECISION NOT NULL,
    confidence_source TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    origin_task_id UUID NOT NULL REFERENCES tasks(id),
    origin_bot_version_id UUID NOT NULL,
    output_event_id UUID NOT NULL REFERENCES conversation_events(id),
    manifest_digest CHAR(64) NOT NULL,
    current_revision INTEGER NOT NULL CHECK(current_revision>=1),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(run_id,normalized_fingerprint)
  )`,
  `CREATE TABLE memory_candidate_revisions (
    candidate_id UUID NOT NULL REFERENCES memory_candidates(id),
    revision INTEGER NOT NULL CHECK(revision>=1),
    body TEXT NOT NULL,
    author_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(candidate_id,revision)
  )`,
  `CREATE TABLE memory_candidate_sources (
    candidate_id UUID NOT NULL REFERENCES memory_candidates(id),
    event_id UUID NOT NULL REFERENCES conversation_events(id),
    PRIMARY KEY(candidate_id,event_id)
  )`,
] as const;

export const CANDIDATE_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_memory_candidate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM memory_extraction_jobs j
        JOIN task_runs r ON r.id=j.run_id AND r.status='completed' AND r.output_event_id=NEW.output_event_id
        JOIN tasks t ON t.id=NEW.origin_task_id AND t.id=r.task_id AND t.workspace_id=NEW.workspace_id
        JOIN run_source_manifests m ON m.run_id=j.run_id AND m.digest=NEW.manifest_digest AND m.digest=j.manifest_digest
        WHERE j.run_id=NEW.run_id AND j.status='running' AND j.claim_token IS NOT NULL
          AND NEW.status='pending' AND NEW.current_revision=1) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='candidate requires a claimed extraction job and completed Run';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_candidate_provenance BEFORE INSERT ON memory_candidates FOR EACH ROW EXECUTE FUNCTION protect_memory_candidate()`,
  `CREATE FUNCTION protect_memory_candidate_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM memory_candidates c WHERE c.id=NEW.candidate_id AND c.current_revision=NEW.revision) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='candidate revision must match the current revision';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_candidate_revision_provenance BEFORE INSERT ON memory_candidate_revisions FOR EACH ROW EXECUTE FUNCTION protect_memory_candidate_revision()`,
  ...['memory_candidates', 'memory_candidate_revisions', 'memory_candidate_sources'].map(
    (table) =>
      `CREATE TRIGGER ${table}_retained BEFORE DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
  ...['memory_candidate_revisions', 'memory_candidate_sources'].map(
    (table) =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
] as const;

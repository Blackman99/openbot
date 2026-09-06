// Migration 0027 follows MEM-03 candidate ledger 0026.
export const REVIEW_DISCLOSURE_VERSION = 'mem-03-audience-v1';
export const GROUP_FACT_VISIBILITY_SUMMARY =
  'Group members with content access can use this reviewed fact in this group.';
export const BOT_FACT_VISIBILITY_SUMMARY =
  'This Bot can use this reviewed fact across its conversations and groups. Participants in those conversations may see it. Other Bots cannot list, search, or receive it.';
export const WORKSPACE_FACT_VISIBILITY_SUMMARY =
  'Workspace facts are available throughout this workspace.';

export const REVIEW_SCHEMA_STATEMENTS = [
  `CREATE TABLE approved_memory_facts (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('group','bot','workspace')),
    scope_id UUID NOT NULL,
    candidate_id UUID NOT NULL UNIQUE REFERENCES memory_candidates(id),
    revision INTEGER NOT NULL CHECK(revision>=1),
    body TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    confidence_source TEXT NOT NULL CHECK(confidence_source='human'),
    approver_user_id UUID NOT NULL REFERENCES users(id),
    approved_at TIMESTAMPTZ NOT NULL,
    version INTEGER NOT NULL CHECK(version=1),
    version_id UUID NOT NULL,
    lineage_digest CHAR(64) NOT NULL
  )`,
  `CREATE TABLE memory_candidate_decisions (
    candidate_id UUID PRIMARY KEY REFERENCES memory_candidates(id),
    workspace_id UUID NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id),
    decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
    expected_revision INTEGER NOT NULL CHECK(expected_revision>=1),
    reviewed_body_hash CHAR(64) NOT NULL,
    destination_scope_kind TEXT CHECK(destination_scope_kind IS NULL OR destination_scope_kind IN ('group','bot','workspace')),
    destination_scope_id UUID,
    approved_fact_id UUID REFERENCES approved_memory_facts(id),
    idempotency_key TEXT NOT NULL,
    command_hash CHAR(64) NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL,
    UNIQUE(workspace_id,actor_user_id,idempotency_key)
  )`,
  `CREATE TABLE memory_candidate_review_intents (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    actor_user_id UUID NOT NULL,
    candidate_id UUID NOT NULL REFERENCES memory_candidates(id),
    expected_revision INTEGER NOT NULL,
    reviewed_body_hash CHAR(64) NOT NULL,
    lineage_digest CHAR(64) NOT NULL,
    destination_scope_kind TEXT NOT NULL CHECK(destination_scope_kind IN ('group','bot','workspace')),
    destination_scope_id UUID NOT NULL,
    destination_version_id UUID,
    confidence DOUBLE PRECISION NOT NULL,
    disclosure_version TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE memory_candidate_review_confirmations (
    intent_id UUID PRIMARY KEY REFERENCES memory_candidate_review_intents(id),
    candidate_id UUID NOT NULL REFERENCES memory_candidate_decisions(candidate_id),
    confirmed_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE run_approved_fact_references (
    run_id UUID NOT NULL REFERENCES task_runs(id),
    fact_id UUID NOT NULL REFERENCES approved_memory_facts(id),
    version_id UUID NOT NULL,
    selected_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(run_id,fact_id)
  )`,
  'CREATE INDEX memory_candidate_review_intent_lookup_idx ON memory_candidate_review_intents(workspace_id,actor_user_id,candidate_id,created_at)',
] as const;

export const REVIEW_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_memory_candidate_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id
        OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.normalized_fingerprint IS DISTINCT FROM OLD.normalized_fingerprint
        OR NEW.proposed_scope_kind IS DISTINCT FROM OLD.proposed_scope_kind
        OR NEW.proposed_scope_id IS DISTINCT FROM OLD.proposed_scope_id
        OR NEW.confidence IS DISTINCT FROM OLD.confidence
        OR NEW.confidence_source IS DISTINCT FROM OLD.confidence_source
        OR NEW.extractor_version IS DISTINCT FROM OLD.extractor_version
        OR NEW.origin_task_id IS DISTINCT FROM OLD.origin_task_id
        OR NEW.origin_bot_version_id IS DISTINCT FROM OLD.origin_bot_version_id
        OR NEW.output_event_id IS DISTINCT FROM OLD.output_event_id
        OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='candidate identity is immutable';
      END IF;
      IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='terminal candidate decisions are immutable';
      END IF;
      IF NEW.status='pending' AND NEW.current_revision=OLD.current_revision+1 THEN
        RETURN NEW;
      END IF;
      IF NEW.status IN ('approved','rejected') AND NEW.current_revision=OLD.current_revision THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='candidate update must edit a pending revision or record one terminal decision';
    END;
    $$`,
  `CREATE TRIGGER memory_candidate_update_guard BEFORE UPDATE ON memory_candidates FOR EACH ROW EXECUTE FUNCTION protect_memory_candidate_update()`,
  `CREATE FUNCTION protect_approved_memory_fact() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM memory_candidates c
        WHERE c.id=NEW.candidate_id AND c.workspace_id=NEW.workspace_id
          AND c.status='approved' AND c.current_revision=NEW.revision) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='approved fact requires a matching approved candidate revision';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER approved_memory_fact_provenance BEFORE INSERT ON approved_memory_facts FOR EACH ROW EXECUTE FUNCTION protect_approved_memory_fact()`,
  `CREATE FUNCTION protect_memory_candidate_decision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.decision='rejected' AND (NEW.destination_scope_kind IS NOT NULL OR NEW.approved_fact_id IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='rejection creates no destination memory';
      ELSIF NEW.decision='approved' AND (NEW.destination_scope_kind IS NULL OR NEW.destination_scope_id IS NULL OR NEW.approved_fact_id IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='approval requires one selected destination and fact';
      ELSIF NOT EXISTS (SELECT 1 FROM memory_candidates c
        WHERE c.id=NEW.candidate_id AND c.workspace_id=NEW.workspace_id
          AND c.status=NEW.decision AND c.current_revision=NEW.expected_revision) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='decision must match the locked candidate state';
      ELSIF NEW.approved_fact_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM approved_memory_facts f WHERE f.id=NEW.approved_fact_id AND f.candidate_id=NEW.candidate_id
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='approval receipt must reference its fact';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_candidate_decision_provenance BEFORE INSERT ON memory_candidate_decisions FOR EACH ROW EXECUTE FUNCTION protect_memory_candidate_decision()`,
  `CREATE FUNCTION protect_memory_candidate_review_confirmation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM memory_candidate_review_intents i
        JOIN memory_candidate_decisions d ON d.candidate_id=NEW.candidate_id
        WHERE i.id=NEW.intent_id AND i.candidate_id=NEW.candidate_id
          AND i.workspace_id=d.workspace_id AND i.actor_user_id=d.actor_user_id
          AND d.decision='approved') THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='review confirmation requires a matching unused preview';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_candidate_review_confirmation_provenance BEFORE INSERT ON memory_candidate_review_confirmations FOR EACH ROW EXECUTE FUNCTION protect_memory_candidate_review_confirmation()`,
  `CREATE FUNCTION protect_run_approved_fact_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM task_runs r
        JOIN tasks t ON t.id=r.task_id
        JOIN approved_memory_facts f ON f.id=NEW.fact_id AND f.version_id=NEW.version_id AND f.workspace_id=t.workspace_id
        WHERE r.id=NEW.run_id AND r.status='running' AND r.claim_token IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='approved fact reference requires a claimed running Run';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER run_approved_fact_reference_provenance BEFORE INSERT ON run_approved_fact_references FOR EACH ROW EXECUTE FUNCTION protect_run_approved_fact_reference()`,
  ...[
    'approved_memory_facts',
    'memory_candidate_decisions',
    'memory_candidate_review_intents',
    'memory_candidate_review_confirmations',
    'run_approved_fact_references',
  ].map(
    (table) =>
      `CREATE TRIGGER ${table}_retained BEFORE DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
  ...[
    'approved_memory_facts',
    'memory_candidate_decisions',
    'memory_candidate_review_intents',
    'memory_candidate_review_confirmations',
    'run_approved_fact_references',
  ].map(
    (table) =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
] as const;

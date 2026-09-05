export const LOCAL_EXTRACTOR_VERSION = 'local-marked-lines-v1';
export const LOCAL_NORMALIZER_VERSION = 'nfc-space-collapse-v1';

// Migration 0025 follows MEM-02 private-memory ledger 0024.
export const EXTRACTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE run_source_manifests (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    digest CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE run_source_manifest_items (
    run_id UUID NOT NULL REFERENCES run_source_manifests(run_id),
    position INTEGER NOT NULL CHECK(position>=1),
    kind TEXT NOT NULL CHECK(kind IN ('bot_instructions','message','group_memory','bot_private_memory')),
    workspace_id UUID NOT NULL,
    conversation_id UUID,
    bot_version_id UUID,
    message_id UUID,
    creation_event_id UUID,
    creation_sequence BIGINT,
    version_event_id UUID,
    memory_version_id UUID,
    private_memory_id UUID,
    source_event_id UUID,
    role TEXT CHECK(role IS NULL OR role IN ('user','assistant','system')),
    PRIMARY KEY(run_id,position)
  )`,
  `CREATE TABLE memory_extraction_jobs (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    output_event_id UUID NOT NULL REFERENCES conversation_events(id),
    manifest_digest CHAR(64) NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','blocked','failed')),
    extractor_version TEXT NOT NULL,
    normalizer_version TEXT NOT NULL,
    attempt_count INTEGER NOT NULL CHECK(attempt_count>=0),
    available_at TIMESTAMPTZ NOT NULL,
    claim_token UUID,
    lease_expires_at TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
] as const;

export const EXTRACTION_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_run_source_manifest() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.id=NEW.run_id AND r.status='running' AND r.claim_token IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='source manifest requires a claimed running Run';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER run_source_manifest_provenance BEFORE INSERT ON run_source_manifests FOR EACH ROW EXECUTE FUNCTION protect_run_source_manifest()`,
  `CREATE FUNCTION protect_run_source_manifest_item() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='bot_instructions' AND (NEW.bot_version_id IS NULL OR NEW.message_id IS NOT NULL OR NEW.memory_version_id IS NOT NULL OR NEW.private_memory_id IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='instruction locator is body-free Bot version attribution';
      ELSIF NEW.kind='message' AND (NEW.message_id IS NULL OR NEW.creation_event_id IS NULL OR NEW.version_event_id IS NULL OR NEW.conversation_id IS NULL OR NEW.role IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='message locator requires current version coordinates';
      ELSIF NEW.kind='group_memory' AND (NEW.memory_version_id IS NULL OR NEW.source_event_id IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='group memory locator requires the selected version';
      ELSIF NEW.kind='bot_private_memory' AND (NEW.private_memory_id IS NULL OR NEW.source_event_id IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='private memory locator requires the selected version';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER run_source_manifest_item_provenance BEFORE INSERT ON run_source_manifest_items FOR EACH ROW EXECUTE FUNCTION protect_run_source_manifest_item()`,
  `CREATE FUNCTION protect_memory_extraction_job() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM task_runs r
        JOIN run_source_manifests m ON m.run_id=r.id AND m.digest=NEW.manifest_digest
        WHERE r.id=NEW.run_id AND r.status='completed' AND r.output_event_id=NEW.output_event_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='extraction job requires a completed Run and its source manifest';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_extraction_job_provenance BEFORE INSERT ON memory_extraction_jobs FOR EACH ROW EXECUTE FUNCTION protect_memory_extraction_job()`,
  ...['run_source_manifests', 'run_source_manifest_items'].map(
    (table) =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
  `CREATE TRIGGER memory_extraction_jobs_retained BEFORE DELETE OR TRUNCATE ON memory_extraction_jobs FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
] as const;

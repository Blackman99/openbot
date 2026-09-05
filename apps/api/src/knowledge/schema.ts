// Migration 0028 follows MEM-03 candidate review ledger 0027.
export const KNOWLEDGE_SCHEMA_STATEMENTS = [
  `CREATE TABLE knowledge_documents (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('bot','group','workspace')),
    scope_id UUID NOT NULL,
    source_attachment_id UUID NOT NULL REFERENCES attachment_objects(id),
    source_conversation_id UUID NOT NULL,
    source_message_id UUID NOT NULL,
    file_version INTEGER NOT NULL CHECK (file_version >= 1),
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    extractor_version TEXT NOT NULL,
    approver_user_id UUID NOT NULL REFERENCES users(id),
    approved_at TIMESTAMPTZ NOT NULL,
    idempotency_key TEXT NOT NULL,
    command_hash CHAR(64) NOT NULL,
    UNIQUE (source_attachment_id, file_version),
    UNIQUE (workspace_id, approver_user_id, idempotency_key),
    FOREIGN KEY (workspace_id, source_conversation_id) REFERENCES conversations(workspace_id, id)
  )`,
  'CREATE INDEX knowledge_document_scope_idx ON knowledge_documents(workspace_id,scope_kind,scope_id,id)',
  `CREATE TABLE knowledge_chunks (
    id UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES knowledge_documents(id),
    position INTEGER NOT NULL CHECK (position >= 1),
    file_version INTEGER NOT NULL CHECK (file_version >= 1),
    locator_kind TEXT NOT NULL CHECK (locator_kind IN ('line','row')),
    locator_start INTEGER NOT NULL CHECK (locator_start >= 1),
    locator_end INTEGER NOT NULL CHECK (locator_end >= locator_start),
    text TEXT NOT NULL,
    UNIQUE (document_id, position)
  )`,
  'CREATE INDEX knowledge_chunk_document_idx ON knowledge_chunks(document_id,position)',
] as const;

export const KNOWLEDGE_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_knowledge_document() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM attachment_objects o
        JOIN conversations c ON c.workspace_id=o.workspace_id AND c.id=o.conversation_id
        JOIN workspace_memberships w ON w.workspace_id=o.workspace_id AND w.user_id=NEW.approver_user_id
        WHERE o.id=NEW.source_attachment_id AND o.original_id IS NULL AND o.state='live'
          AND o.workspace_id=NEW.workspace_id AND o.conversation_id=NEW.source_conversation_id
          AND o.message_id=NEW.source_message_id AND o.filename=NEW.filename
          AND o.media_type=NEW.media_type AND o.sha256=NEW.sha256) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge document requires a live original attachment and current approver';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER knowledge_document_provenance BEFORE INSERT ON knowledge_documents FOR EACH ROW EXECUTE FUNCTION protect_knowledge_document()`,
  `CREATE FUNCTION protect_knowledge_chunk() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.text = '' OR NOT EXISTS (
        SELECT 1 FROM knowledge_documents d WHERE d.id=NEW.document_id AND d.file_version=NEW.file_version
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge chunk requires its document version and non-empty text';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER knowledge_chunk_provenance BEFORE INSERT ON knowledge_chunks FOR EACH ROW EXECUTE FUNCTION protect_knowledge_chunk()`,
  ...['knowledge_documents', 'knowledge_chunks'].map(
    (table) =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
] as const;

// Migration 0029 follows scoped knowledge documents 0028.
export const RUN_KNOWLEDGE_SCHEMA_STATEMENTS = [
  `CREATE TABLE run_knowledge_references (
    run_id UUID NOT NULL REFERENCES task_runs(id),
    chunk_id UUID NOT NULL REFERENCES knowledge_chunks(id),
    document_id UUID NOT NULL REFERENCES knowledge_documents(id),
    selected_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(run_id, chunk_id)
  )`,
  'CREATE INDEX run_knowledge_reference_run_idx ON run_knowledge_references(run_id,chunk_id)',
] as const;

export const RUN_KNOWLEDGE_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_run_knowledge_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM task_runs r
        JOIN tasks t ON t.id=r.task_id
        JOIN conversations conv ON conv.id=t.conversation_id AND conv.workspace_id=t.workspace_id
        JOIN knowledge_chunks c ON c.id=NEW.chunk_id AND c.document_id=NEW.document_id
        JOIN knowledge_documents d ON d.id=c.document_id AND d.workspace_id=t.workspace_id
        JOIN attachment_objects o ON o.id=d.source_attachment_id AND o.original_id IS NULL AND o.state='live'
          AND o.workspace_id=d.workspace_id AND o.conversation_id=d.source_conversation_id AND o.message_id=d.source_message_id
        LEFT JOIN message_purges p ON p.workspace_id=d.workspace_id AND p.conversation_id=d.source_conversation_id AND p.message_id=d.source_message_id
        WHERE r.id=NEW.run_id AND r.status='running' AND r.claim_token IS NOT NULL AND p.message_id IS NULL
          AND (
            (d.scope_kind='bot' AND d.scope_id=t.bot_id)
            OR (d.scope_kind='workspace' AND d.scope_id=t.workspace_id)
            OR (d.scope_kind='group' AND conv.group_id IS NOT NULL AND d.scope_id=conv.group_id)
          )
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Run knowledge reference requires a claimed running Run and live scoped chunk';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER run_knowledge_reference_provenance BEFORE INSERT ON run_knowledge_references FOR EACH ROW EXECUTE FUNCTION protect_run_knowledge_reference()`,
  `CREATE TRIGGER run_knowledge_references_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON run_knowledge_references FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
] as const;

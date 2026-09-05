// Migration 0029 follows the first KNW-01 extraction ledger 0028.
export const KNOWLEDGE_PROMOTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE knowledge_promotion_intents (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id),
    conversation_id UUID NOT NULL,
    source_message_id UUID NOT NULL,
    source_attachment_id UUID NOT NULL REFERENCES attachment_objects(id),
    file_version INTEGER NOT NULL CHECK (file_version >= 1),
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    extractor_version TEXT NOT NULL,
    content_hash CHAR(64) NOT NULL,
    destination_scope_kind TEXT NOT NULL CHECK (destination_scope_kind IN ('bot','group','workspace')),
    destination_scope_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id)
  )`,
  'CREATE INDEX knowledge_promotion_intent_lookup_idx ON knowledge_promotion_intents(workspace_id,actor_user_id,source_attachment_id,created_at)',
  `CREATE TABLE knowledge_promotion_confirmations (
    intent_id UUID PRIMARY KEY REFERENCES knowledge_promotion_intents(id),
    document_id UUID NOT NULL REFERENCES knowledge_documents(id),
    confirmed_at TIMESTAMPTZ NOT NULL,
    UNIQUE (document_id)
  )`,
] as const;

export const KNOWLEDGE_PROMOTION_POSTGRES_GUARDS = [
  `CREATE OR REPLACE FUNCTION protect_knowledge_document() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
      IF NEW.scope_kind='workspace' AND (NEW.scope_id<>NEW.workspace_id OR NOT EXISTS (
        SELECT 1 FROM workspace_memberships w
        WHERE w.workspace_id=NEW.workspace_id AND w.user_id=NEW.approver_user_id
          AND w.role IN ('owner','administrator')
      )) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge document requires current destination admission';
      ELSIF NEW.scope_kind='group' AND NOT EXISTS (
        SELECT 1 FROM groups g
        JOIN group_memberships m ON m.group_id=g.id AND m.user_id=NEW.approver_user_id
        WHERE g.id=NEW.scope_id AND g.workspace_id=NEW.workspace_id
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge document requires current destination admission';
      ELSIF NEW.scope_kind='bot' AND NOT EXISTS (
        SELECT 1 FROM bots b
        JOIN bot_acl a ON a.bot_id=b.id AND a.user_id=NEW.approver_user_id AND a.role IN ('owner','editor')
        WHERE b.id=NEW.scope_id AND b.workspace_id=NEW.workspace_id AND b.lifecycle_state='active'
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge document requires current destination admission';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE FUNCTION protect_knowledge_promotion_intent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM attachment_objects o
        JOIN workspace_memberships w ON w.workspace_id=o.workspace_id AND w.user_id=NEW.actor_user_id
        WHERE o.id=NEW.source_attachment_id AND o.original_id IS NULL AND o.state='live'
          AND o.workspace_id=NEW.workspace_id AND o.conversation_id=NEW.conversation_id
          AND o.message_id=NEW.source_message_id AND o.filename=NEW.filename
          AND o.media_type=NEW.media_type AND o.sha256=NEW.sha256) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge preview requires a live original attachment and current actor';
      END IF;
      IF NEW.destination_scope_kind='workspace' AND (NEW.destination_scope_id<>NEW.workspace_id OR NOT EXISTS (
        SELECT 1 FROM workspace_memberships w
        WHERE w.workspace_id=NEW.workspace_id AND w.user_id=NEW.actor_user_id
          AND w.role IN ('owner','administrator')
      )) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge preview requires current destination admission';
      ELSIF NEW.destination_scope_kind='group' AND NOT EXISTS (
        SELECT 1 FROM groups g
        JOIN group_memberships m ON m.group_id=g.id AND m.user_id=NEW.actor_user_id
        WHERE g.id=NEW.destination_scope_id AND g.workspace_id=NEW.workspace_id
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge preview requires current destination admission';
      ELSIF NEW.destination_scope_kind='bot' AND NOT EXISTS (
        SELECT 1 FROM bots b
        JOIN bot_acl a ON a.bot_id=b.id AND a.user_id=NEW.actor_user_id AND a.role IN ('owner','editor')
        WHERE b.id=NEW.destination_scope_id AND b.workspace_id=NEW.workspace_id AND b.lifecycle_state='active'
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge preview requires current destination admission';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER knowledge_promotion_intent_provenance BEFORE INSERT ON knowledge_promotion_intents FOR EACH ROW EXECUTE FUNCTION protect_knowledge_promotion_intent()`,
  `CREATE FUNCTION protect_knowledge_promotion_confirmation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM knowledge_promotion_intents i
        JOIN knowledge_documents d ON d.id=NEW.document_id
        WHERE i.id=NEW.intent_id AND i.workspace_id=d.workspace_id AND i.actor_user_id=d.approver_user_id
          AND i.source_attachment_id=d.source_attachment_id AND i.conversation_id=d.source_conversation_id
          AND i.source_message_id=d.source_message_id AND i.file_version=d.file_version
          AND i.destination_scope_kind=d.scope_kind AND i.destination_scope_id=d.scope_id
          AND i.expires_at>NEW.confirmed_at) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='knowledge confirmation requires a current unused preview';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER knowledge_promotion_confirmation_provenance BEFORE INSERT ON knowledge_promotion_confirmations FOR EACH ROW EXECUTE FUNCTION protect_knowledge_promotion_confirmation()`,
  ...['knowledge_promotion_intents', 'knowledge_promotion_confirmations'].map(
    (table) =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
] as const;

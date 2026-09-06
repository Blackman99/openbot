export const ATTACHMENT_SCHEMA_STATEMENTS = [
  'ALTER TABLE conversations ADD CONSTRAINT conversations_attachment_scope UNIQUE(workspace_id,id)',
  `CREATE TABLE attachment_objects (
    id UUID PRIMARY KEY,
    storage_id UUID NOT NULL UNIQUE,
    workspace_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    message_id UUID,
    actor_user_id UUID NOT NULL REFERENCES users(id),
    original_id UUID REFERENCES attachment_objects(id),
    backend_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged','live','purging','deleting','deleted')),
    filename TEXT,
    media_type TEXT,
    bytes INTEGER CHECK (bytes > 0 AND bytes <= 67108864),
    sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    cleanup_after TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    cleanup_token UUID,
    FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
    CHECK (state IN ('deleting','deleted') OR (filename IS NOT NULL AND media_type IS NOT NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL))
  )`,
  'CREATE UNIQUE INDEX attachment_message_original ON attachment_objects(conversation_id,message_id) WHERE original_id IS NULL AND message_id IS NOT NULL',
  'CREATE INDEX attachment_cleanup_idx ON attachment_objects(backend_id,cleanup_after)',
  `CREATE TABLE message_purges (
    workspace_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    message_id UUID NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id),
    state TEXT NOT NULL CHECK (state IN ('purging','complete')),
    requested_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY(conversation_id,message_id),
    FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
  )`,
] as const;
export const ATTACHMENT_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_attachment_object() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.storage_id,NEW.workspace_id,NEW.conversation_id,NEW.actor_user_id,NEW.original_id,NEW.backend_id,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.storage_id,OLD.workspace_id,OLD.conversation_id,OLD.actor_user_id,OLD.original_id,OLD.backend_id,OLD.created_at)
          OR (NEW.message_id IS DISTINCT FROM OLD.message_id AND NOT (OLD.state='staged' AND OLD.message_id IS NULL AND NEW.state='live'))
          OR (ROW(NEW.filename,NEW.media_type,NEW.bytes,NEW.sha256) IS DISTINCT FROM ROW(OLD.filename,OLD.media_type,OLD.bytes,OLD.sha256)
            AND NOT (NEW.state='deleted' AND NEW.filename IS NULL AND NEW.media_type IS NULL AND NEW.bytes IS NULL AND NEW.sha256 IS NULL))
          OR NOT ((OLD.state='staged' AND NEW.state IN ('staged','live','purging','deleting'))
            OR (OLD.state='live' AND NEW.state IN ('live','purging'))
            OR (OLD.state='purging' AND NEW.state IN ('purging','deleting'))
            OR (OLD.state='deleting' AND NEW.state IN ('deleting','deleted'))
            OR (OLD.state='deleted' AND NEW.state IN ('deleted','deleting')))
          OR (NEW.state='purging' AND NOT EXISTS (SELECT 1 FROM message_purges p
            WHERE p.workspace_id=NEW.workspace_id AND p.conversation_id=NEW.conversation_id AND p.message_id=NEW.message_id AND p.state='purging')) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='attachment provenance is immutable';
        END IF;
      ELSIF NEW.state<>'staged' THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='attachment requires a durable staged intent';
      END IF;
      IF NEW.original_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attachment_objects p WHERE p.id=NEW.original_id
        AND p.workspace_id=NEW.workspace_id AND p.conversation_id=NEW.conversation_id AND p.message_id=NEW.message_id AND p.original_id IS NULL AND (NEW.state<>'live' OR p.state='live')) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='derived attachment requires exact provenance';
      END IF;
      IF NEW.state='live' THEN
        IF NEW.message_id IS NULL OR EXISTS (SELECT 1 FROM message_purges p WHERE p.conversation_id=NEW.conversation_id AND p.message_id=NEW.message_id)
          OR NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id=NEW.conversation_id AND e.message_id=NEW.message_id
            AND e.event_type='message.created' AND (NEW.original_id IS NOT NULL OR e.event_data->>'attachmentId'=NEW.id::text)) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='attachment requires its live message reference';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER attachment_objects_protected BEFORE INSERT OR UPDATE ON attachment_objects FOR EACH ROW EXECUTE FUNCTION protect_attachment_object()`,
  `CREATE TRIGGER attachment_objects_retained BEFORE DELETE OR TRUNCATE ON attachment_objects FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION protect_message_purge() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.workspace_id,NEW.conversation_id,NEW.message_id,NEW.actor_user_id,NEW.requested_at)
          IS DISTINCT FROM ROW(OLD.workspace_id,OLD.conversation_id,OLD.message_id,OLD.actor_user_id,OLD.requested_at)
          OR OLD.state<>'purging' OR NEW.state<>'complete' OR NEW.completed_at IS NULL
          OR EXISTS (SELECT 1 FROM attachment_objects o WHERE o.workspace_id=NEW.workspace_id AND o.conversation_id=NEW.conversation_id AND o.message_id=NEW.message_id AND o.state<>'deleted')
          OR EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id=NEW.conversation_id AND e.message_id=NEW.message_id AND (e.body IS NOT NULL OR e.reason IS NOT NULL OR e.command_hash<>repeat('0',64))) THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='message purge completion and identity are protected';
        END IF;
      ELSE
        IF NEW.state<>'purging' OR NEW.completed_at IS NOT NULL
          OR NOT EXISTS (SELECT 1 FROM conversations c JOIN conversation_events e ON e.conversation_id=c.id
            JOIN workspace_memberships w ON w.workspace_id=c.workspace_id AND w.user_id=NEW.actor_user_id
            WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.conversation_id AND e.message_id=NEW.message_id AND e.event_type='message.created'
              AND ((c.group_id IS NULL AND c.creator_user_id=NEW.actor_user_id AND e.actor_user_id=NEW.actor_user_id)
                OR (c.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM group_memberships g WHERE g.group_id=c.group_id AND g.user_id=NEW.actor_user_id
                  AND (e.actor_user_id=NEW.actor_user_id OR g.role IN ('owner','admin'))))))
          OR NOT EXISTS (SELECT 1 FROM attachment_objects o WHERE o.workspace_id=NEW.workspace_id AND o.conversation_id=NEW.conversation_id AND o.message_id=NEW.message_id AND o.original_id IS NULL)
          OR NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id=NEW.conversation_id AND e.message_id=NEW.message_id AND e.event_type='message.deleted') THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='message attachment purge requires its authorized human message';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER message_purges_protected BEFORE INSERT OR UPDATE ON message_purges FOR EACH ROW EXECUTE FUNCTION protect_message_purge()`,
  `CREATE TRIGGER message_purges_retained BEFORE DELETE OR TRUNCATE ON message_purges FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  // Add the one explicit content-erasure operation; identity/order remain append-only.
  'DROP TRIGGER conversation_events_immutable ON conversation_events',
  `CREATE TRIGGER conversation_events_retained BEFORE DELETE OR TRUNCATE ON conversation_events FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION protect_conversation_content_redaction() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.conversation_events'::regclass))
        OR (to_jsonb(NEW) - ARRAY['body','reason','command_hash']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['body','reason','command_hash'])
        OR NEW.body IS NOT NULL OR NEW.reason IS NOT NULL OR NEW.command_hash<>repeat('0',64)
        OR NOT EXISTS (SELECT 1 FROM message_purges p WHERE p.conversation_id=OLD.conversation_id AND p.message_id=OLD.message_id AND p.state='purging')
        OR EXISTS (SELECT 1 FROM attachment_objects o WHERE o.conversation_id=OLD.conversation_id AND o.message_id=OLD.message_id AND o.state<>'deleted') THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='conversation ledger is append-only outside completed message content purge';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER conversation_events_content_immutable BEFORE UPDATE ON conversation_events FOR EACH ROW EXECUTE FUNCTION protect_conversation_content_redaction()`,
  `CREATE FUNCTION purge_conversation_message(p_workspace UUID,p_conversation UUID,p_message UUID) RETURNS VOID
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM public.message_purges p INNER JOIN public.conversations c ON c.id=p.conversation_id
          WHERE p.workspace_id=p_workspace AND c.workspace_id=p_workspace AND p.conversation_id=p_conversation AND p.message_id=p_message AND p.state='purging')
        OR NOT EXISTS (SELECT 1 FROM public.attachment_objects o WHERE o.workspace_id=p_workspace AND o.conversation_id=p_conversation AND o.message_id=p_message AND o.original_id IS NULL)
        OR EXISTS (SELECT 1 FROM public.attachment_objects o WHERE o.workspace_id=p_workspace AND o.conversation_id=p_conversation AND o.message_id=p_message AND o.state<>'deleted')
        OR NOT EXISTS (SELECT 1 FROM public.conversation_events e WHERE e.conversation_id=p_conversation AND e.message_id=p_message AND e.event_type='message.deleted') THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='message purge is not ready';
      END IF;
      UPDATE public.conversation_events SET body=NULL,reason=NULL,command_hash=repeat('0',64)
        WHERE conversation_id=p_conversation AND message_id=p_message;
    END;
    $$`,
  'REVOKE ALL ON FUNCTION purge_conversation_message(UUID,UUID,UUID) FROM PUBLIC',
] as const;

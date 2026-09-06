// Migration 0024 follows the actual COL-07 cancellation ledger 0023.
export const PRIVATE_MEMORY_SCHEMA_STATEMENTS = [
  `CREATE TABLE memory_promotion_intents (
    id UUID PRIMARY KEY, workspace_id UUID NOT NULL, actor_user_id UUID NOT NULL REFERENCES users(id),
    source_group_id UUID NOT NULL REFERENCES groups(id), source_memory_id UUID NOT NULL REFERENCES group_memories(id),
    destination_bot_id UUID NOT NULL REFERENCES bots(id), content_hash CHAR(64) NOT NULL,
    lineage_digest CHAR(64) NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX memory_promotion_intent_lookup_idx ON memory_promotion_intents(workspace_id,actor_user_id,source_memory_id,created_at)',
  `CREATE TABLE bot_private_memories (
    id UUID PRIMARY KEY, workspace_id UUID NOT NULL, bot_id UUID NOT NULL REFERENCES bots(id),
    source_group_id UUID NOT NULL REFERENCES groups(id), source_memory_id UUID NOT NULL REFERENCES group_memories(id),
    source_memory_version_id UUID NOT NULL REFERENCES memory_versions(id),
    source_event_id UUID NOT NULL REFERENCES conversation_events(id),
    approver_user_id UUID NOT NULL REFERENCES users(id), approved_at TIMESTAMPTZ NOT NULL,
    version INTEGER NOT NULL CHECK(version=1), version_id UUID NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL, command_hash CHAR(64) NOT NULL,
    UNIQUE(bot_id,approver_user_id,idempotency_key), UNIQUE(bot_id,source_memory_id)
  )`,
  'CREATE INDEX bot_private_memory_scope_idx ON bot_private_memories(workspace_id,bot_id,id)',
  `CREATE TABLE memory_promotion_confirmations (
    intent_id UUID PRIMARY KEY REFERENCES memory_promotion_intents(id),
    private_memory_id UUID NOT NULL REFERENCES bot_private_memories(id),
    confirmed_at TIMESTAMPTZ NOT NULL, UNIQUE(private_memory_id)
  )`,
  `CREATE TABLE run_private_memory_references (
    run_id UUID NOT NULL REFERENCES task_runs(id), private_memory_id UUID NOT NULL REFERENCES bot_private_memories(id),
    source_event_id UUID NOT NULL REFERENCES conversation_events(id), selected_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(run_id,private_memory_id)
  )`,
] as const;

export const PRIVATE_MEMORY_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_bot_private_memory() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM group_memories m
        JOIN memory_versions v ON v.id=NEW.source_memory_version_id AND v.memory_id=m.id
        JOIN bots b ON b.id=NEW.bot_id AND b.workspace_id=NEW.workspace_id AND b.lifecycle_state='active'
        JOIN bot_acl a ON a.bot_id=b.id AND a.user_id=NEW.approver_user_id AND a.role IN ('owner','editor')
        JOIN workspace_memberships w ON w.workspace_id=NEW.workspace_id AND w.user_id=NEW.approver_user_id
        JOIN group_memberships g ON g.group_id=NEW.source_group_id AND g.user_id=NEW.approver_user_id
        WHERE m.id=NEW.source_memory_id AND m.workspace_id=NEW.workspace_id AND m.group_id=NEW.source_group_id
          AND v.source_event_id=NEW.source_event_id AND NEW.version=1) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='private memory requires current source and destination admission';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER bot_private_memory_provenance BEFORE INSERT ON bot_private_memories FOR EACH ROW EXECUTE FUNCTION protect_bot_private_memory()`,
  `CREATE FUNCTION protect_memory_promotion_confirmation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM memory_promotion_intents i
        JOIN bot_private_memories p ON p.id=NEW.private_memory_id
        WHERE i.id=NEW.intent_id AND i.workspace_id=p.workspace_id AND i.actor_user_id=p.approver_user_id
          AND i.source_group_id=p.source_group_id AND i.source_memory_id=p.source_memory_id
          AND i.destination_bot_id=p.bot_id AND i.expires_at>NEW.confirmed_at) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='promotion confirmation requires a current unused preview';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_promotion_confirmation_provenance BEFORE INSERT ON memory_promotion_confirmations FOR EACH ROW EXECUTE FUNCTION protect_memory_promotion_confirmation()`,
  `CREATE FUNCTION protect_run_private_memory_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id
        JOIN bot_private_memories p ON p.id=NEW.private_memory_id AND p.workspace_id=t.workspace_id AND p.bot_id=t.bot_id
        JOIN memory_versions v ON v.id=p.source_memory_version_id AND v.source_event_id=NEW.source_event_id
        JOIN group_memories m ON m.id=p.source_memory_id AND m.id=v.memory_id
        JOIN conversation_events source ON source.id=v.source_event_id AND source.conversation_id=m.conversation_id AND source.message_id=v.source_message_id
        WHERE r.id=NEW.run_id AND r.status='running' AND r.claim_token IS NOT NULL
          AND source.event_type IN ('message.created','message.edited','bot.message.created') AND source.body IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM conversation_events later WHERE later.conversation_id=m.conversation_id AND later.message_id=v.source_message_id AND later.sequence>source.sequence)
          AND NOT EXISTS (SELECT 1 FROM message_purges purge WHERE purge.workspace_id=m.workspace_id AND purge.conversation_id=m.conversation_id AND purge.message_id=v.source_message_id)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Run private memory reference requires the destination Bot and current source';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER run_private_memory_reference_provenance BEFORE INSERT ON run_private_memory_references FOR EACH ROW EXECUTE FUNCTION protect_run_private_memory_reference()`,
  ...[
    'memory_promotion_intents',
    'bot_private_memories',
    'memory_promotion_confirmations',
    'run_private_memory_references',
  ].map(
    (table) =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
] as const;

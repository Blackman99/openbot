// Migration 0020 follows the actual COL-05 conversation delivery migration 0019.
export const MEMORY_SCHEMA_STATEMENTS = [
  `CREATE TABLE group_memories (
    id UUID PRIMARY KEY, workspace_id UUID NOT NULL, group_id UUID NOT NULL REFERENCES groups(id),
    conversation_id UUID NOT NULL, creator_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL, idempotency_key TEXT NOT NULL, command_hash CHAR(64) NOT NULL,
    FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
    UNIQUE(group_id,creator_user_id,idempotency_key)
  )`,
  'CREATE INDEX group_memory_scope_idx ON group_memories(workspace_id,group_id,id)',
  `CREATE TABLE memory_versions (
    id UUID PRIMARY KEY, memory_id UUID NOT NULL REFERENCES group_memories(id),
    version INTEGER NOT NULL CHECK(version=1), source_message_id UUID NOT NULL,
    source_event_id UUID NOT NULL REFERENCES conversation_events(id),
    source_creation_event_id UUID NOT NULL REFERENCES conversation_events(id),
    source_creation_sequence BIGINT NOT NULL CHECK(source_creation_sequence>0 AND source_creation_sequence<=9007199254740991),
    confidence DOUBLE PRECISION NOT NULL CHECK(confidence>=0 AND confidence<=1),
    UNIQUE(memory_id,version)
  )`,
  'CREATE INDEX memory_source_idx ON memory_versions(source_message_id,source_event_id)',
  `CREATE TABLE run_memory_references (
    run_id UUID NOT NULL REFERENCES task_runs(id), memory_version_id UUID NOT NULL REFERENCES memory_versions(id),
    source_event_id UUID NOT NULL REFERENCES conversation_events(id), selected_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(run_id,memory_version_id)
  )`,
] as const;

export const MEMORY_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_group_memory() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM conversations c JOIN workspace_memberships w ON w.workspace_id=c.workspace_id
        JOIN group_memberships g ON g.group_id=c.group_id AND g.user_id=w.user_id
        WHERE c.id=NEW.conversation_id AND c.workspace_id=NEW.workspace_id AND c.group_id=NEW.group_id AND w.user_id=NEW.creator_user_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='memory requires its current human group provenance';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER group_memory_provenance BEFORE INSERT ON group_memories FOR EACH ROW EXECUTE FUNCTION protect_group_memory()`,
  `CREATE FUNCTION protect_memory_version() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM group_memories m
        JOIN conversation_events o ON o.conversation_id=m.conversation_id AND o.id=NEW.source_creation_event_id
        JOIN conversation_events e ON e.conversation_id=m.conversation_id AND e.id=NEW.source_event_id
        WHERE m.id=NEW.memory_id AND o.message_id=NEW.source_message_id AND e.message_id=o.message_id
          AND o.event_type IN ('message.created','bot.message.created') AND o.sequence=NEW.source_creation_sequence
          AND e.event_type IN ('message.created','message.edited','bot.message.created') AND e.body IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM conversation_events later WHERE later.conversation_id=m.conversation_id AND later.message_id=o.message_id AND later.sequence>e.sequence)
          AND NOT EXISTS (SELECT 1 FROM message_purges p WHERE p.workspace_id=m.workspace_id AND p.conversation_id=m.conversation_id AND p.message_id=o.message_id)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='memory version requires its current message source';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_version_provenance BEFORE INSERT ON memory_versions FOR EACH ROW EXECUTE FUNCTION protect_memory_version()`,
  `CREATE FUNCTION protect_run_memory_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id
        JOIN conversation_events trigger_event ON trigger_event.id=t.trigger_event_id
        JOIN memory_versions v ON v.id=NEW.memory_version_id AND v.source_event_id=NEW.source_event_id
        JOIN group_memories m ON m.id=v.memory_id AND m.workspace_id=t.workspace_id AND m.conversation_id=t.conversation_id
        JOIN group_bot_grants g ON g.id=t.group_grant_id AND g.workspace_id=t.workspace_id AND g.group_id=m.group_id AND g.conversation_id=t.conversation_id AND g.bot_id=t.bot_id AND g.close_event_id IS NULL
        JOIN workspace_memberships human_workspace ON human_workspace.workspace_id=t.workspace_id AND human_workspace.user_id=t.execution_user_id
        JOIN group_memberships human_group ON human_group.group_id=m.group_id AND human_group.user_id=t.execution_user_id
        JOIN workspace_memberships grantor_workspace ON grantor_workspace.workspace_id=t.workspace_id AND grantor_workspace.user_id=g.granted_by_user_id
        JOIN bot_acl grantor_bot ON grantor_bot.bot_id=t.bot_id AND grantor_bot.user_id=g.granted_by_user_id
        JOIN bots b ON b.id=t.bot_id AND b.workspace_id=t.workspace_id AND b.lifecycle_state='active'
        JOIN conversation_events source ON source.id=v.source_event_id AND source.conversation_id=t.conversation_id AND source.message_id=v.source_message_id
        WHERE r.id=NEW.run_id AND r.status='running' AND r.claim_token IS NOT NULL
          AND v.source_creation_sequence>=g.lower_bound AND v.source_creation_sequence<=trigger_event.sequence
          AND source.event_type IN ('message.created','message.edited','bot.message.created') AND source.body IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM conversation_events later WHERE later.conversation_id=t.conversation_id AND later.message_id=v.source_message_id AND later.sequence>source.sequence)
          AND NOT EXISTS (SELECT 1 FROM message_purges p WHERE p.workspace_id=t.workspace_id AND p.conversation_id=t.conversation_id AND p.message_id=v.source_message_id)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Run memory reference requires its current exact source authority';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER run_memory_reference_provenance BEFORE INSERT ON run_memory_references FOR EACH ROW EXECUTE FUNCTION protect_run_memory_reference()`,
  ...['group_memories', 'memory_versions', 'run_memory_references'].map(
    (table) =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
] as const;

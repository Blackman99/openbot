// Migration 0031 follows knowledge FTS 0030. Append-only revisions and
// revocation events; memory_versions version=1 source rows stay unchanged.
export const MEMORY_LIFECYCLE_SCHEMA_STATEMENTS = [
  `CREATE TABLE memory_revisions (
    id UUID PRIMARY KEY,
    memory_id UUID NOT NULL REFERENCES group_memories(id),
    version INTEGER NOT NULL CHECK (version >= 2 AND version <= 1000),
    kind TEXT NOT NULL CHECK (kind IN ('edit', 'tombstone')),
    body TEXT,
    actor_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL,
    previous_version_id UUID NOT NULL,
    UNIQUE (memory_id, version),
    CHECK (
      (kind = 'edit' AND body IS NOT NULL AND body <> '')
      OR (kind = 'tombstone' AND body IS NULL)
    )
  )`,
  'CREATE INDEX memory_revision_memory_idx ON memory_revisions(memory_id, version)',
  `CREATE TABLE memory_revocation_events (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('group_memory', 'private_memory', 'approved_fact')),
    target_id UUID NOT NULL,
    target_version_id UUID NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('pending', 'retain', 'revoke')),
    reason TEXT NOT NULL CHECK (reason IN ('source_deleted', 'source_purged', 'source_tombstoned')),
    source_message_id UUID NOT NULL,
    actor_user_id UUID REFERENCES users(id),
    retained_body TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (
      (action = 'retain' AND retained_body IS NOT NULL AND retained_body <> '')
      OR (action <> 'retain' AND retained_body IS NULL)
    ),
    CHECK (
      (action = 'pending' AND actor_user_id IS NULL)
      OR (action <> 'pending' AND actor_user_id IS NOT NULL)
    )
  )`,
  'CREATE INDEX memory_revocation_target_idx ON memory_revocation_events(target_kind, target_id, created_at)',
] as const;

export const MEMORY_LIFECYCLE_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_memory_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = 'edit' AND (NEW.body IS NULL OR btrim(NEW.body) = '') THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='memory edit requires replacement text';
      END IF;
      IF EXISTS (SELECT 1 FROM memory_revisions r WHERE r.memory_id=NEW.memory_id AND r.kind='tombstone') THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='tombstoned memory cannot gain another revision';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM group_memories m
        JOIN memory_versions v ON v.memory_id=m.id AND v.version=1
        JOIN group_memberships g ON g.group_id=m.group_id AND g.user_id=NEW.actor_user_id
        WHERE m.id=NEW.memory_id AND (
          (NEW.version=2 AND NEW.previous_version_id=v.id)
          OR EXISTS (
            SELECT 1 FROM memory_revisions prior
            WHERE prior.memory_id=NEW.memory_id AND prior.id=NEW.previous_version_id AND prior.version=NEW.version-1
          )
        )
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='memory revision requires its previous version and group actor';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_revision_provenance BEFORE INSERT ON memory_revisions FOR EACH ROW EXECUTE FUNCTION protect_memory_revision()`,
  `CREATE FUNCTION protect_memory_revocation_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action='revoke' AND EXISTS (
        SELECT 1 FROM memory_revocation_events r
        WHERE r.target_kind=NEW.target_kind AND r.target_id=NEW.target_id AND r.action='revoke'
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='revoked memory cannot change again';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER memory_revocation_event_provenance BEFORE INSERT ON memory_revocation_events FOR EACH ROW EXECUTE FUNCTION protect_memory_revocation_event()`,
  ...['memory_revisions', 'memory_revocation_events'].map(
    (table) =>
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  ),
] as const;

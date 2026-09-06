export const ROUTING_SCHEMA_STATEMENTS = [
  `CREATE TABLE group_routing_settings (
    group_id UUID PRIMARY KEY REFERENCES groups(id),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    default_grant_id UUID REFERENCES group_bot_grants(id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    updated_by_user_id UUID NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE task_routing_decisions (
    task_id UUID PRIMARY KEY REFERENCES tasks(id),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    group_id UUID NOT NULL REFERENCES groups(id),
    request_hash CHAR(64) NOT NULL,
    algorithm TEXT NOT NULL CHECK (algorithm = 'local-terms-v1'),
    reason TEXT NOT NULL CHECK (reason IN ('mention','default','local-match')),
    decision JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
] as const;

export const ROUTING_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_group_routing_setting() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.group_id,NEW.workspace_id) IS DISTINCT FROM ROW(OLD.group_id,OLD.workspace_id)
          OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='routing settings require a new revision and retained scope';
        END IF;
      ELSIF NEW.revision<>1 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='new routing settings start at revision one';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM groups g JOIN group_memberships gm ON gm.group_id=g.id
        JOIN workspace_memberships wm ON wm.workspace_id=g.workspace_id AND wm.user_id=gm.user_id
        WHERE g.id=NEW.group_id AND g.workspace_id=NEW.workspace_id
        AND gm.user_id=NEW.updated_by_user_id AND gm.role IN ('owner','admin')) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='routing setting requires current group management';
      END IF;
      IF NEW.default_grant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM group_bot_grants g
        JOIN bots b ON b.id=g.bot_id AND b.workspace_id=g.workspace_id
        WHERE g.id=NEW.default_grant_id AND g.workspace_id=NEW.workspace_id AND g.group_id=NEW.group_id
        AND g.close_event_id IS NULL AND b.lifecycle_state='active') THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='routing default requires its exact active group grant';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER group_routing_settings_protected BEFORE INSERT OR UPDATE ON group_routing_settings
    FOR EACH ROW EXECUTE FUNCTION protect_group_routing_setting()`,
  `CREATE TRIGGER group_routing_settings_retained BEFORE DELETE OR TRUNCATE ON group_routing_settings
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION protect_task_routing_decision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE candidate JSONB; previous_bot TEXT; seen_lead BOOLEAN := FALSE;
    BEGIN
      IF NEW.request_hash !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(NEW.decision) IS DISTINCT FROM 'object'
        OR NOT (NEW.decision ?& ARRAY['algorithm','reason','lead','candidates'])
        OR NEW.decision-ARRAY['algorithm','reason','lead','candidates']<>'{}'::jsonb
        OR NEW.decision->>'algorithm' IS DISTINCT FROM NEW.algorithm
        OR NEW.decision->>'reason' IS DISTINCT FROM NEW.reason
        OR jsonb_typeof(NEW.decision->'lead') IS DISTINCT FROM 'object'
        OR jsonb_typeof(NEW.decision->'candidates') IS DISTINCT FROM 'array'
        OR octet_length(NEW.decision::text)>1048576 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='routing decision shape is invalid';
      END IF;
      IF jsonb_array_length(NEW.decision->'candidates') NOT BETWEEN 1 AND 8
        OR NOT EXISTS (SELECT 1 FROM tasks t JOIN conversations c ON c.id=t.conversation_id
          JOIN task_runs r ON r.task_id=t.id AND r.attempt=1
          WHERE t.id=NEW.task_id AND t.workspace_id=NEW.workspace_id AND t.conversation_id=NEW.conversation_id
          AND c.workspace_id=NEW.workspace_id AND c.group_id=NEW.group_id
          AND t.status='queued' AND r.status='queued' AND t.created_at=NEW.created_at
          AND NEW.decision->'lead'->>'botId'=t.bot_id::text
          AND NEW.decision->'lead'->>'versionId'=t.bot_version_id::text
          AND NEW.decision->'lead'->>'grantId'=t.group_grant_id::text) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='routing decision requires its exact queued group Task';
      END IF;
      FOR candidate IN SELECT value FROM jsonb_array_elements(NEW.decision->'candidates') LOOP
        IF jsonb_typeof(candidate) IS DISTINCT FROM 'object'
          OR NOT (candidate ?& ARRAY['botId','grantId','versionId','name','roleDescription','description','score','matchedTerms'])
          OR candidate-ARRAY['botId','grantId','versionId','name','roleDescription','description','score','matchedTerms']<>'{}'::jsonb
          OR jsonb_typeof(candidate->'score') IS DISTINCT FROM 'number'
          OR (candidate->>'score') !~ '^[0-9]+$'
          OR jsonb_typeof(candidate->'matchedTerms') IS DISTINCT FROM 'array'
          OR (previous_bot IS NOT NULL AND previous_bot>=candidate->>'botId') THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='routing candidates must be bounded public evidence';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM group_bot_grants g
          JOIN bot_versions v ON v.bot_id=g.bot_id AND v.id::text=candidate->>'versionId'
          JOIN bots b ON b.id=g.bot_id AND b.workspace_id=g.workspace_id
          WHERE g.id::text=candidate->>'grantId' AND g.workspace_id=NEW.workspace_id
          AND g.group_id=NEW.group_id AND g.conversation_id=NEW.conversation_id
          AND g.close_event_id IS NULL AND b.lifecycle_state='active'
          AND candidate-ARRAY['score','matchedTerms']=jsonb_build_object(
            'botId',g.bot_id::text,'grantId',g.id::text,'versionId',v.id::text,
            'name',v.configuration->>'name','roleDescription',v.configuration->>'roleDescription',
            'description',v.configuration->>'description')) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='routing candidate provenance is invalid';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(candidate->'matchedTerms') AS term(value)
          WHERE jsonb_typeof(term.value) IS DISTINCT FROM 'string' OR term.value='""'::jsonb) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='routing match evidence must contain text terms';
        END IF;
        IF candidate-ARRAY['score','matchedTerms']=NEW.decision->'lead' THEN seen_lead:=TRUE; END IF;
        previous_bot:=candidate->>'botId';
      END LOOP;
      IF NOT seen_lead THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='routing Lead must be one admitted candidate';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER task_routing_decisions_protected BEFORE INSERT ON task_routing_decisions
    FOR EACH ROW EXECUTE FUNCTION protect_task_routing_decision()`,
  `CREATE TRIGGER task_routing_decisions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON task_routing_decisions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
] as const;

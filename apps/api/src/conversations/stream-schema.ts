// Migration0019 follows the accepted attachment migration0018. Delivery rows
// are a reclaimable ordered projection; the source ledger remains immutable.
export const CONVERSATION_STREAM_SCHEMA_STATEMENTS = [
  `CREATE TABLE conversation_delivery_state (
    conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
    floor BIGINT NOT NULL CHECK (floor>=0 AND floor<=9007199254740991),
    retained_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_count>=0),
    retained_bytes BIGINT NOT NULL DEFAULT 0 CHECK (retained_bytes>=0)
  )`,
  `INSERT INTO conversation_delivery_state(conversation_id,floor)
    SELECT id,last_sequence FROM conversations`,
  `CREATE TABLE task_run_streams (
    run_id UUID PRIMARY KEY REFERENCES task_runs(id),
    delivered_bytes INTEGER NOT NULL DEFAULT 0 CHECK (delivered_bytes>=0 AND delivered_bytes<=128000)
  )`,
  `CREATE TABLE conversation_delivery_events (
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    sequence BIGINT NOT NULL CHECK (sequence>0 AND sequence<=9007199254740991),
    occurred_at TIMESTAMPTZ NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('message.changed','conversation.invalidated','task.run.updated','assistant.delta')),
    ledger_event_id UUID UNIQUE REFERENCES conversation_events(id),
    run_id UUID REFERENCES task_runs(id),
    run_status TEXT CHECK (run_status IS NULL OR run_status IN ('queued','running','completed','failed')),
    execution JSONB,
    delta_text TEXT,
    start_byte INTEGER,
    end_byte INTEGER,
    byte_size INTEGER NOT NULL CHECK (byte_size>=2048 AND byte_size<=262144),
    PRIMARY KEY (conversation_id,sequence),
    UNIQUE (run_id,run_status),
    UNIQUE (run_id,start_byte),
    CHECK ((event_type='task.run.updated' AND run_status IS NOT NULL) OR (event_type<>'task.run.updated' AND run_status IS NULL)),
    CHECK ((event_type IN ('message.changed','conversation.invalidated') AND ledger_event_id IS NOT NULL AND run_id IS NULL AND execution IS NULL AND delta_text IS NULL AND start_byte IS NULL AND end_byte IS NULL)
      OR (event_type='task.run.updated' AND ledger_event_id IS NULL AND run_id IS NOT NULL AND execution IS NOT NULL AND delta_text IS NULL AND start_byte IS NULL AND end_byte IS NULL)
      OR (event_type='assistant.delta' AND ledger_event_id IS NULL AND run_id IS NOT NULL AND execution IS NULL AND delta_text IS NOT NULL AND start_byte>=0 AND end_byte>start_byte AND end_byte<=128000))
  )`,
  'CREATE INDEX conversation_delivery_expiry_idx ON conversation_delivery_events(occurred_at,conversation_id,sequence)',
  'CREATE INDEX conversation_delivery_run_idx ON conversation_delivery_events(run_id,sequence)',
  `CREATE TABLE task_run_delivery_receipts (
    run_id UUID NOT NULL REFERENCES task_runs(id),
    run_status TEXT NOT NULL CHECK (run_status IN ('queued','running','completed','failed')),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    sequence BIGINT NOT NULL CHECK (sequence>0 AND sequence<=9007199254740991),
    PRIMARY KEY (run_id,run_status),
    UNIQUE (conversation_id,sequence)
  )`,
] as const;

export const CONVERSATION_STREAM_POSTGRES_GUARDS = [
  `CREATE FUNCTION protect_conversation_delivery() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE target UUID; tail BIGINT; retained_floor BIGINT;
    BEGIN
      IF TG_OP='UPDATE' THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='delivery event is immutable';
      END IF;
      target := CASE WHEN TG_OP='DELETE' THEN OLD.conversation_id ELSE NEW.conversation_id END;
      SELECT last_sequence INTO STRICT tail FROM conversations WHERE id=target;
      SELECT floor INTO STRICT retained_floor FROM conversation_delivery_state WHERE conversation_id=target;
      IF TG_OP='DELETE' THEN
        IF OLD.sequence>retained_floor THEN
          RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='delivery deletion must reclaim an advanced prefix';
        END IF;
        RETURN OLD;
      END IF;
      IF NEW.sequence<>tail OR NEW.sequence<=retained_floor
        OR NEW.byte_size<2048+octet_length(COALESCE(NEW.delta_text,''))+octet_length(COALESCE(NEW.execution::text,'')) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery requires its allocated sequence and bounded size';
      END IF;
      IF NEW.ledger_event_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_events e WHERE e.id=NEW.ledger_event_id AND e.conversation_id=target AND e.sequence=NEW.sequence
          AND ((NEW.event_type='message.changed' AND e.message_id IS NOT NULL)
            OR (NEW.event_type='conversation.invalidated' AND e.event_type IN ('bot.joined','bot.removed')))) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery reference must name its own ledger event';
      END IF;
      IF NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=NEW.run_id AND t.conversation_id=target) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery Run must belong to its conversation';
      END IF;
      IF NEW.event_type='task.run.updated' AND NOT EXISTS (
        SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=NEW.run_id
          AND NEW.execution->>'taskId'=t.id::text AND NEW.execution->>'runId'=r.id::text
          AND NEW.execution->>'attempt'=r.attempt::text AND NEW.execution->>'runStatus'=r.status AND NEW.run_status=r.status
          AND NEW.execution->>'taskStatus'=r.status AND t.status=r.status) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery state must match its committed Run';
      END IF;
      IF NEW.event_type='assistant.delta' AND (octet_length(NEW.delta_text)>4096 OR octet_length(NEW.delta_text)<>NEW.end_byte-NEW.start_byte OR NOT EXISTS (
        SELECT 1 FROM task_runs r JOIN task_run_streams s ON s.run_id=r.id
        WHERE r.id=NEW.run_id AND r.status='running' AND r.deadline_at>clock_timestamp() AND s.delivered_bytes=NEW.start_byte)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delta requires its live claim and contiguous byte offset';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER conversation_delivery_protected BEFORE INSERT OR UPDATE OR DELETE ON conversation_delivery_events
    FOR EACH ROW EXECUTE FUNCTION protect_conversation_delivery()`,
  `CREATE TRIGGER conversation_delivery_no_truncate BEFORE TRUNCATE ON conversation_delivery_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION protect_conversation_delivery_state() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE tail BIGINT;
    BEGIN
      SELECT last_sequence INTO STRICT tail FROM conversations WHERE id=NEW.conversation_id;
      IF NEW.floor>tail OR (TG_OP='UPDATE' AND (NEW.conversation_id<>OLD.conversation_id OR NEW.floor<OLD.floor)) THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='delivery floor can only advance within its conversation';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER conversation_delivery_state_protected BEFORE INSERT OR UPDATE ON conversation_delivery_state
    FOR EACH ROW EXECUTE FUNCTION protect_conversation_delivery_state()`,
  `CREATE TRIGGER conversation_delivery_state_retained BEFORE DELETE OR TRUNCATE ON conversation_delivery_state
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION assert_conversation_delivery_prefix() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE target UUID; state conversation_delivery_state%ROWTYPE; tail BIGINT; actual_count BIGINT; actual_bytes BIGINT; first_sequence BIGINT;
    BEGIN
      IF TG_TABLE_NAME='conversations' THEN
        target := NEW.id;
      ELSIF TG_OP='DELETE' THEN
        target := OLD.conversation_id;
      ELSE
        target := NEW.conversation_id;
      END IF;
      SELECT * INTO STRICT state FROM conversation_delivery_state WHERE conversation_id=target;
      SELECT last_sequence INTO STRICT tail FROM conversations WHERE id=target;
      SELECT count(*),COALESCE(sum(byte_size),0),min(sequence) INTO actual_count,actual_bytes,first_sequence FROM conversation_delivery_events WHERE conversation_id=target;
      IF actual_count<>state.retained_count OR actual_bytes<>state.retained_bytes OR actual_count<>tail-state.floor
        OR actual_count>10000 OR actual_bytes>16777216 OR (first_sequence IS NOT NULL AND first_sequence<>state.floor+1) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delivery retention must preserve an atomic bounded contiguous suffix';
      END IF;
      RETURN NULL;
    END;
    $$`,
  `CREATE CONSTRAINT TRIGGER conversation_delivery_prefix AFTER INSERT OR DELETE ON conversation_delivery_events
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_conversation_delivery_prefix()`,
  `CREATE CONSTRAINT TRIGGER conversation_delivery_state_prefix AFTER INSERT OR UPDATE ON conversation_delivery_state
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_conversation_delivery_prefix()`,
  `CREATE CONSTRAINT TRIGGER conversations_delivery_prefix AFTER UPDATE ON conversations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_conversation_delivery_prefix()`,
  `CREATE FUNCTION protect_task_run_stream() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM task_runs WHERE id=NEW.run_id AND status='running') OR
        (TG_OP='INSERT' AND NEW.delivered_bytes<>0) OR
        (TG_OP='UPDATE' AND (NEW.run_id<>OLD.run_id OR NEW.delivered_bytes<=OLD.delivered_bytes OR NEW.delivered_bytes>OLD.delivered_bytes+4096
          OR NOT EXISTS (SELECT 1 FROM conversation_delivery_events e WHERE e.run_id=NEW.run_id AND e.event_type='assistant.delta' AND e.start_byte=OLD.delivered_bytes AND e.end_byte=NEW.delivered_bytes))) THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Run stream progress requires its contiguous live delta';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER task_run_stream_protected BEFORE INSERT OR UPDATE ON task_run_streams
    FOR EACH ROW EXECUTE FUNCTION protect_task_run_stream()`,
  `CREATE TRIGGER task_run_stream_retained BEFORE DELETE OR TRUNCATE ON task_run_streams
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
  `CREATE FUNCTION protect_run_delivery_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM conversation_delivery_events e WHERE e.conversation_id=NEW.conversation_id AND e.sequence=NEW.sequence
        AND e.event_type='task.run.updated' AND e.run_id=NEW.run_id AND e.run_status=NEW.run_status) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='transition receipt requires its matching delivery';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER run_delivery_receipt_protected BEFORE INSERT ON task_run_delivery_receipts
    FOR EACH ROW EXECUTE FUNCTION protect_run_delivery_receipt()`,
  `CREATE TRIGGER run_delivery_receipt_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON task_run_delivery_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_conversation_event_mutation()`,
] as const;

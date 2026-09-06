import pg from 'pg';

const { Client } = pg;
const client = new Client();
const runtimePassword = process.env.OPENBOT_DATABASE_PASSWORD;

if (
  !runtimePassword ||
  Buffer.byteLength(runtimePassword, 'utf8') < 16 ||
  Buffer.byteLength(runtimePassword, 'utf8') > 1024
) {
  throw new Error('OPENBOT_DATABASE_PASSWORD must be between 16 and 1024 bytes');
}
if (
  runtimePassword === 'replace-runtime-me' &&
  process.env.OPENBOT_ALLOW_INSECURE_LOCAL_PASSWORD !== 'true'
) {
  throw new Error(
    'Refusing the example API database password without the explicit local-development override',
  );
}

let connected = false;
let transactionOpen = false;
let failed = false;

try {
  await client.connect();
  connected = true;
  await client.query('BEGIN');
  transactionOpen = true;
  await client.query("SELECT set_config('openbot.runtime_password', $1, true)", [runtimePassword]);
  await client.query(`
    DO $provision_runtime_role$
    DECLARE
      runtime_password text := current_setting('openbot.runtime_password', true);
    BEGIN
      IF current_user = 'openbot_runtime' OR session_user = 'openbot_runtime' THEN
        RAISE EXCEPTION 'The migration role and runtime role must be different';
      END IF;

      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openbot_runtime') THEN
          EXECUTE format(
            'CREATE ROLE openbot_runtime WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL ''infinity''',
            runtime_password
          );
        ELSE
          EXECUTE format(
            'ALTER ROLE openbot_runtime WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL ''infinity''',
            runtime_password
          );
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to configure openbot_runtime role';
      END;

      ALTER ROLE openbot_runtime RESET ALL;
      EXECUTE format(
        'ALTER ROLE openbot_runtime IN DATABASE %I RESET ALL',
        current_database()
      );
      EXECUTE format(
        'ALTER ROLE openbot_runtime IN DATABASE %I SET search_path TO pg_catalog, public',
        current_database()
      );
    END;
    $provision_runtime_role$;
  `);
  await client.query(`
    DO $revoke_runtime_memberships$
    DECLARE
      granted_role record;
    BEGIN
      FOR granted_role IN
        SELECT role_to_revoke.rolname
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
        JOIN pg_catalog.pg_roles AS role_to_revoke ON role_to_revoke.oid = membership.roleid
        WHERE member_role.rolname = 'openbot_runtime'
      LOOP
        EXECUTE format('REVOKE %I FROM openbot_runtime', granted_role.rolname);
      END LOOP;
    END;
    $revoke_runtime_memberships$;

    DO $assert_runtime_not_owner$
    DECLARE
      runtime_role_oid oid;
      owned_object text;
    BEGIN
      SELECT oid INTO STRICT runtime_role_oid
      FROM pg_catalog.pg_roles
      WHERE rolname = 'openbot_runtime';

      SELECT datname INTO owned_object
      FROM pg_catalog.pg_database
      WHERE datdba = runtime_role_oid
      LIMIT 1;
      IF owned_object IS NOT NULL THEN
        RAISE EXCEPTION 'openbot_runtime must not own database %', owned_object;
      END IF;

      SELECT nspname INTO owned_object
      FROM pg_catalog.pg_namespace
      WHERE nspowner = runtime_role_oid
      LIMIT 1;
      IF owned_object IS NOT NULL THEN
        RAISE EXCEPTION 'openbot_runtime must not own schema %', owned_object;
      END IF;

      SELECT format('%I.%I', namespace.nspname, relation.relname) INTO owned_object
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relowner = runtime_role_oid
      LIMIT 1;
      IF owned_object IS NOT NULL THEN
        RAISE EXCEPTION 'openbot_runtime must not own relation %', owned_object;
      END IF;

      SELECT format('%I.%I', namespace.nspname, procedure.proname) INTO owned_object
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE procedure.proowner = runtime_role_oid
      LIMIT 1;
      IF owned_object IS NOT NULL THEN
        RAISE EXCEPTION 'openbot_runtime must not own function %', owned_object;
      END IF;
    END;
    $assert_runtime_not_owner$;

    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    DO $$
    BEGIN
      EXECUTE format(
        'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC',
        current_database()
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON DATABASE %I FROM openbot_runtime',
        current_database()
      );
      EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO openbot_runtime',
        current_database()
      );
    END;
    $$;
    REVOKE ALL ON SCHEMA public FROM openbot_runtime;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openbot_runtime;
    REVOKE ALL ON audit_events FROM openbot_runtime;
    REVOKE ALL ON FUNCTION reject_audit_event_mutation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION reject_audit_event_mutation() FROM openbot_runtime;
    REVOKE ALL ON FUNCTION reject_bot_version_mutation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION reject_bot_version_mutation() FROM openbot_runtime;
    REVOKE ALL ON FUNCTION reject_conversation_event_mutation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION reject_conversation_event_mutation() FROM openbot_runtime;
    REVOKE ALL ON FUNCTION protect_conversation_subject() FROM PUBLIC;
    REVOKE ALL ON FUNCTION protect_conversation_subject() FROM openbot_runtime;
    REVOKE ALL ON FUNCTION protect_group_bot_grant() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_task() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_task_run() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_bot_output() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_group_memory() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_memory_version() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_run_memory_reference() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_bot_private_memory() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_memory_promotion_confirmation() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_run_private_memory_reference() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_run_source_manifest() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_run_source_manifest_item() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_memory_extraction_job() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_memory_candidate() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_memory_candidate_revision() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_memory_candidate_update() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_approved_memory_fact() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_memory_candidate_decision() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_memory_candidate_review_confirmation() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_run_approved_fact_reference() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_knowledge_document() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_knowledge_chunk() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_run_knowledge_reference() FROM PUBLIC, openbot_runtime;
    DO $revoke_optional_knowledge_fts$
    BEGIN
      IF to_regprocedure('knowledge_fts_match(text,text)') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION knowledge_fts_match(TEXT, TEXT) FROM PUBLIC, openbot_runtime;
      END IF;
      IF to_regprocedure('knowledge_fts_rank(text,text)') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION knowledge_fts_rank(TEXT, TEXT) FROM PUBLIC, openbot_runtime;
      END IF;
    END
    $revoke_optional_knowledge_fts$;
    REVOKE ALL ON FUNCTION protect_group_routing_setting() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_task_routing_decision() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION protect_task_retry_command() FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION require_current_task_run() FROM PUBLIC, openbot_runtime;
    DO $revoke_optional_task_tree$
    BEGIN
      IF to_regprocedure('lock_task_ancestry(uuid)') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION lock_task_ancestry(UUID) FROM PUBLIC, openbot_runtime;
      END IF;
      IF to_regprocedure('protect_task_tree()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION protect_task_tree() FROM PUBLIC, openbot_runtime;
      END IF;
      IF to_regprocedure('protect_task_cancel_command()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION protect_task_cancel_command() FROM PUBLIC, openbot_runtime;
      END IF;
      IF to_regprocedure('protect_task_run_cancellation()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION protect_task_run_cancellation() FROM PUBLIC, openbot_runtime;
      END IF;
      IF to_regprocedure('require_cancelled_task_tree()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION require_cancelled_task_tree() FROM PUBLIC, openbot_runtime;
      END IF;
      IF to_regprocedure('protect_task_partial_output()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION protect_task_partial_output() FROM PUBLIC, openbot_runtime;
      END IF;
      IF to_regprocedure('require_task_partial_checkpoint()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION require_task_partial_checkpoint() FROM PUBLIC, openbot_runtime;
      END IF;
      IF to_regprocedure('fence_cancelled_task_publication()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION fence_cancelled_task_publication() FROM PUBLIC, openbot_runtime;
      END IF;
    END
    $revoke_optional_task_tree$;

    GRANT USAGE ON SCHEMA public TO openbot_runtime;
    GRANT SELECT ON openbot_schema_migrations TO openbot_runtime;
    GRANT SELECT, INSERT ON
      users,
      local_credentials,
      workspaces,
      workspace_memberships,
      workspace_invitations,
      groups,
      group_memberships,
      bots,
      bot_versions,
      bot_acl,
      conversations,
      conversation_events,
      group_bot_grants,
      tasks,
      task_runs,
      task_retry_commands,
      instance_claims,
      sessions
    TO openbot_runtime;
    DO $grant_optional_task_tree$
    BEGIN
      IF to_regclass('task_cancel_commands') IS NOT NULL THEN
        GRANT SELECT, INSERT ON task_cancel_commands, task_run_cancellations TO openbot_runtime;
      END IF;
      IF to_regclass('task_pause_commands') IS NOT NULL THEN
        GRANT SELECT, INSERT ON task_pause_commands, task_run_pauses, task_run_pause_checkpoints TO openbot_runtime;
      END IF;
      IF to_regprocedure('lock_task_ancestry(uuid)') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION lock_task_ancestry(UUID) TO openbot_runtime;
      END IF;
    END
    $grant_optional_task_tree$;
    GRANT UPDATE (owner_user_id) ON instance_claims TO openbot_runtime;
    GRANT UPDATE (revoked_at) ON sessions TO openbot_runtime;
    GRANT UPDATE (name, description) ON workspaces TO openbot_runtime;
    GRANT UPDATE (current_version_id, visibility, lifecycle_state, deleted_at, recovery_deadline, pre_deleted_state) ON bots TO openbot_runtime;
    GRANT UPDATE (role) ON bot_acl TO openbot_runtime;
    GRANT DELETE ON bot_acl TO openbot_runtime;
    GRANT UPDATE (last_sequence) ON conversations TO openbot_runtime;
    GRANT SELECT, INSERT, DELETE ON conversation_delivery_events TO openbot_runtime;
    GRANT SELECT, INSERT ON conversation_delivery_state, task_run_streams, task_run_delivery_receipts TO openbot_runtime;
    GRANT UPDATE (floor, retained_count, retained_bytes) ON conversation_delivery_state TO openbot_runtime;
    GRANT UPDATE (delivered_bytes) ON task_run_streams TO openbot_runtime;
    GRANT SELECT, INSERT, DELETE ON task_run_partial_outputs TO openbot_runtime;
    GRANT UPDATE (body, end_byte, updated_at) ON task_run_partial_outputs TO openbot_runtime;
    GRANT UPDATE (status) ON tasks TO openbot_runtime;
    GRANT UPDATE (status, started_at, finished_at, claim_token, deadline_at, provider_scope_kind,
      provider_scope_id, connection_id, connection_revision, protocol, model_id, input_tokens,
      output_tokens, error_code, output_event_id) ON task_runs TO openbot_runtime;
    GRANT UPDATE (close_event_id, close_sequence, closed_at, closure_reason) ON group_bot_grants TO openbot_runtime;
    GRANT UPDATE (revoked_at, consumed_at, consumed_by_user_id) ON workspace_invitations TO openbot_runtime;
    GRANT UPDATE (role) ON workspace_memberships TO openbot_runtime;
    GRANT UPDATE (role) ON group_memberships TO openbot_runtime;
    GRANT UPDATE (name, description, visibility, updated_at) ON groups TO openbot_runtime;
    GRANT DELETE ON workspace_memberships TO openbot_runtime;
    GRANT SELECT, INSERT, DELETE ON oidc_identities, oidc_transactions TO openbot_runtime;
    GRANT UPDATE (consumed_at) ON oidc_transactions TO openbot_runtime;
    GRANT DELETE ON group_memberships TO openbot_runtime;
    GRANT SELECT, INSERT ON attachment_objects, message_purges TO openbot_runtime;
    GRANT SELECT, INSERT ON group_memories, memory_versions, run_memory_references,
      memory_promotion_intents, bot_private_memories, memory_promotion_confirmations,
      run_private_memory_references, run_source_manifests, run_source_manifest_items,
      memory_extraction_jobs, memory_candidates, memory_candidate_revisions,
      memory_candidate_sources, approved_memory_facts, memory_candidate_decisions,
      memory_candidate_review_intents, memory_candidate_review_confirmations,
      run_approved_fact_references, knowledge_documents, knowledge_chunks, run_knowledge_references,
      memory_revisions, memory_revocation_events TO openbot_runtime;
    DO $grant_optional_knowledge_fts$
    BEGIN
      IF to_regprocedure('knowledge_fts_match(text,text)') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION knowledge_fts_match(TEXT, TEXT) TO openbot_runtime;
      END IF;
      IF to_regprocedure('knowledge_fts_rank(text,text)') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION knowledge_fts_rank(TEXT, TEXT) TO openbot_runtime;
      END IF;
    END
    $grant_optional_knowledge_fts$;
    GRANT UPDATE (status, attempt_count, available_at, claim_token, lease_expires_at, last_error_code, updated_at)
      ON memory_extraction_jobs TO openbot_runtime;
    GRANT UPDATE (status, current_revision) ON memory_candidates TO openbot_runtime;
    GRANT SELECT, INSERT ON group_routing_settings, task_routing_decisions TO openbot_runtime;
    GRANT UPDATE (default_grant_id,revision,updated_by_user_id,updated_at) ON group_routing_settings TO openbot_runtime;
    GRANT UPDATE (state, message_id, filename, media_type, bytes, sha256, lease_until, cleanup_after, attempts, cleanup_token) ON attachment_objects TO openbot_runtime;
    GRANT UPDATE (state, completed_at) ON message_purges TO openbot_runtime;
    GRANT EXECUTE ON FUNCTION purge_conversation_message(UUID,UUID,UUID) TO openbot_runtime;
    GRANT SELECT, INSERT ON avatar_objects, bot_avatar_references TO openbot_runtime;
    GRANT UPDATE (state, lease_until, cleanup_after, attempts, cleanup_token) ON avatar_objects TO openbot_runtime;
    CREATE OR REPLACE FUNCTION task_has_automatic_continuation_receipt(target uuid, run_id uuid, actor uuid)
    RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      SELECT EXISTS (
        SELECT 1 FROM audit_events a
        JOIN task_runs previous ON previous.task_id=target AND previous.id::text=a.metadata->>'sourceRunId'
        JOIN task_runs next_run ON next_run.id=run_id AND next_run.task_id=target
        WHERE a.event_type='task.queued' AND a.actor_user_id=actor
          AND a.metadata->>'taskId'=target::text AND a.metadata->>'runId'=run_id::text
          AND a.metadata->>'origin' IN ('provider_retry','model_fallback')
          AND previous.status='failed' AND previous.attempt::bigint+1=next_run.attempt
      )
    $$;
    CREATE OR REPLACE FUNCTION task_queued_audit_metadata(run_id uuid)
    RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      SELECT a.metadata FROM audit_events a
      WHERE a.event_type='task.queued' AND a.metadata->>'runId'=run_id::text
      ORDER BY a.occurred_at DESC LIMIT 1
    $$;
    CREATE OR REPLACE FUNCTION task_queued_audit_metadata_for_task(target uuid)
    RETURNS SETOF jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      SELECT a.metadata FROM audit_events a
      WHERE a.event_type='task.queued' AND a.metadata->>'taskId'=target::text
    $$;
    CREATE OR REPLACE FUNCTION task_run_has_listed_continuation_binding(target uuid, run_id uuid, scope_kind text, scope_id uuid, connection_id uuid, model_id text)
    RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      SELECT EXISTS (
        SELECT 1 FROM tasks t
        JOIN bot_versions v ON v.id=t.bot_version_id AND v.bot_id=t.bot_id
        JOIN audit_events a ON a.event_type='task.queued'
          AND a.metadata->>'runId'=run_id::text AND a.metadata->>'taskId'=t.id::text
          AND a.metadata->>'origin' IN ('provider_retry','model_fallback')
        WHERE t.id=target
          AND a.metadata->'binding'->'scope'->>'kind'=scope_kind
          AND a.metadata->'binding'->'scope'->>'id'=scope_id::text
          AND a.metadata->'binding'->>'connectionId'=connection_id::text
          AND a.metadata->'binding'->>'modelId'=model_id
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(v.configuration->'fallbackBindings','[]'::jsonb)) fb
            WHERE fb->'scope'->>'kind'=scope_kind AND fb->'scope'->>'id'=scope_id::text
              AND fb->>'connectionId'=connection_id::text AND fb->>'modelId'=model_id
          )
      )
    $$;
    REVOKE ALL ON FUNCTION task_has_automatic_continuation_receipt(uuid,uuid,uuid) FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION task_queued_audit_metadata(uuid) FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION task_queued_audit_metadata_for_task(uuid) FROM PUBLIC, openbot_runtime;
    REVOKE ALL ON FUNCTION task_run_has_listed_continuation_binding(uuid,uuid,text,uuid,uuid,text) FROM PUBLIC, openbot_runtime;
    GRANT EXECUTE ON FUNCTION task_has_automatic_continuation_receipt(uuid,uuid,uuid) TO openbot_runtime;
    GRANT EXECUTE ON FUNCTION task_queued_audit_metadata(uuid) TO openbot_runtime;
    GRANT EXECUTE ON FUNCTION task_queued_audit_metadata_for_task(uuid) TO openbot_runtime;
    GRANT EXECUTE ON FUNCTION task_run_has_listed_continuation_binding(uuid,uuid,text,uuid,uuid,text) TO openbot_runtime;
    CREATE OR REPLACE FUNCTION task_has_manual_resume_receipt(target uuid, run_id uuid, actor uuid)
    RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      SELECT EXISTS (
        SELECT 1 FROM audit_events a
        JOIN task_runs previous ON previous.task_id=target AND previous.id::text=a.metadata->>'sourceRunId'
        JOIN task_runs next_run ON next_run.id=run_id AND next_run.task_id=target
        WHERE a.event_type='task.queued' AND a.actor_user_id=actor
          AND a.metadata->>'taskId'=target::text AND a.metadata->>'runId'=run_id::text
          AND a.metadata->>'origin'='manual_resume'
          AND previous.status='paused' AND previous.attempt::bigint+1=next_run.attempt
      )
    $$;
    REVOKE ALL ON FUNCTION task_has_manual_resume_receipt(uuid,uuid,uuid) FROM PUBLIC, openbot_runtime;
    GRANT EXECUTE ON FUNCTION task_has_manual_resume_receipt(uuid,uuid,uuid) TO openbot_runtime;
    GRANT INSERT ON audit_events TO openbot_runtime;
    GRANT SELECT, INSERT ON api_tokens TO openbot_runtime;
    GRANT UPDATE (last_used_at, revoked_at) ON api_tokens TO openbot_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON personal_model_connections TO openbot_runtime;
    GRANT SELECT, INSERT ON workspace_model_connections TO openbot_runtime;
    GRANT UPDATE (metadata, sealed_credentials, revision, updated_at, policy) ON workspace_model_connections TO openbot_runtime;
  `);
  await client.query('COMMIT');
  transactionOpen = false;
} catch {
  failed = true;
  if (transactionOpen) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the fixed, secret-free failure below even if rollback also fails.
    }
  }
} finally {
  if (connected) {
    try {
      await client.end();
    } catch {
      failed = true;
    }
  }
}

if (failed) {
  process.stderr.write('Runtime database privilege provisioning failed\n');
  process.exitCode = 1;
}

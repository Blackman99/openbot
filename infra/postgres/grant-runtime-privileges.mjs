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
      instance_claims,
      sessions
    TO openbot_runtime;
    GRANT UPDATE (owner_user_id) ON instance_claims TO openbot_runtime;
    GRANT UPDATE (revoked_at) ON sessions TO openbot_runtime;
    GRANT UPDATE (name, description) ON workspaces TO openbot_runtime;
    GRANT UPDATE (current_version_id) ON bots TO openbot_runtime;
    GRANT UPDATE (revoked_at, consumed_at, consumed_by_user_id) ON workspace_invitations TO openbot_runtime;
    GRANT UPDATE (role) ON workspace_memberships TO openbot_runtime;
    GRANT UPDATE (role) ON group_memberships TO openbot_runtime;
    GRANT UPDATE (name, description, visibility, updated_at) ON groups TO openbot_runtime;
    GRANT DELETE ON workspace_memberships TO openbot_runtime;
    GRANT SELECT, INSERT, DELETE ON oidc_identities, oidc_transactions TO openbot_runtime;
    GRANT UPDATE (consumed_at) ON oidc_transactions TO openbot_runtime;
    GRANT DELETE ON group_memberships TO openbot_runtime;
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

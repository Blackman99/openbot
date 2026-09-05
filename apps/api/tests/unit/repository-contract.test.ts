import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

describe('repository contract', () => {
  it('declares the complete AGPL-3.0-only license', () => {
    const packageJson = JSON.parse(readFileSync(`${repositoryRoot}/package.json`, 'utf8')) as {
      license?: string;
    };
    const license = readFileSync(`${repositoryRoot}/LICENSE`, 'utf8');

    expect(packageJson.license).toBe('AGPL-3.0-only');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(license).toContain('Version 3, 19 November 2007');
  });

  it('documents a complete environment using only safe local defaults', () => {
    const environment = Object.fromEntries(
      readFileSync(`${repositoryRoot}/.env.example`, 'utf8')
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

    expect(environment).toEqual({
      OBJECT_STORAGE_BACKEND: 'local',
      OBJECT_STORAGE_LOCAL_PATH: '/var/lib/openbot/objects',
      OBJECT_STORAGE_S3_ENDPOINT: '',
      OBJECT_STORAGE_S3_BUCKET: '',
      OBJECT_STORAGE_S3_REGION: 'us-east-1',
      OBJECT_STORAGE_S3_ACCESS_KEY_ID: '',
      OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: '',
      OBJECT_STORAGE_S3_SESSION_TOKEN: '',
      BODY_SIZE_LIMIT: '3M',
      OIDC_ISSUER_URL: '',
      OIDC_CLIENT_ID: '',
      OIDC_CLIENT_SECRET: '',
      API_BASE_URL: 'http://localhost:3001',
      API_HOST: '127.0.0.1',
      API_PORT: '3001',
      DATABASE_CONNECTION_TIMEOUT_MS: '1000',
      DATABASE_QUERY_TIMEOUT_MS: '1000',
      DATABASE_URL: 'postgresql://openbot:replace-me@localhost:5432/openbot',
      OPENBOT_ALLOW_INSECURE_LOCAL_PASSWORD: 'true',
      OPENBOT_BIND_ADDRESS: '127.0.0.1',
      OPENBOT_DATABASE_PASSWORD: 'replace-runtime-me',
      OPENBOT_PROVIDER_ALLOWED_HOSTS: 'api.openai.com',
      OPENBOT_PROVIDER_ALLOWED_SCHEMES: 'https',
      OPENBOT_PROVIDER_ENCRYPTION_KEY: '',
      OPENBOT_PROVIDER_PRIVATE_CIDRS: '',
      OPENBOT_SETUP_TOKEN: 'local-only-openbot-setup-token-change-me',
      POSTGRES_DB: 'openbot',
      POSTGRES_PASSWORD: 'replace-me',
      POSTGRES_PORT: '5432',
      POSTGRES_USER: 'openbot',
      WEB_HOST: '127.0.0.1',
      WEB_ORIGIN: 'http://localhost:3000',
      WEB_PORT: '3000',
    });
  });

  it('defines dependency-ordered PostgreSQL, migration, API, worker, and web services', () => {
    const compose = parse(readFileSync(`${repositoryRoot}/compose.yaml`, 'utf8')) as {
      networks?: Record<string, { internal?: boolean } | null>;
      services: Record<
        string,
        {
          build?: { context: string; dockerfile: string };
          cap_drop?: string[];
          command?: string[];
          depends_on?: Record<string, { condition: string }>;
          environment?: Record<string, string | number>;
          healthcheck?: { test: string[] };
          image?: string;
          entrypoint?: string[];
          networks?: string[];
          ports?: string[];
          read_only?: boolean;
          security_opt?: string[];
          tmpfs?: string[];
          volumes?: string[];
        }
      >;
    };

    expect(Object.keys(compose.services)).toEqual(['postgres', 'migrate', 'api', 'worker', 'web']);
    expect(compose.services.postgres?.image).toBe('postgres:17.11-alpine');
    expect(compose.services.postgres?.healthcheck?.test[0]).toBe('CMD-SHELL');
    expect(compose.services.migrate?.depends_on?.postgres?.condition).toBe('service_healthy');
    expect(compose.services.api?.depends_on).toEqual({
      migrate: { condition: 'service_completed_successfully' },
    });
    expect(compose.services.worker?.depends_on).toEqual({
      migrate: { condition: 'service_completed_successfully' },
    });
    expect(compose.services.worker?.command).toEqual(['node', 'dist/worker.js']);
    expect(compose.services.worker?.ports).toBeUndefined();
    expect(compose.services.worker?.volumes).toBeUndefined();
    expect(compose.services.worker?.environment).not.toHaveProperty('OPENBOT_SETUP_TOKEN');
    expect(compose.services.worker?.environment).toMatchObject({
      PGUSER: 'openbot_runtime',
      PGPASSWORD: '${OPENBOT_DATABASE_PASSWORD:?set OPENBOT_DATABASE_PASSWORD in .env}',
      OPENBOT_PROVIDER_ENCRYPTION_KEY: '${OPENBOT_PROVIDER_ENCRYPTION_KEY:-}',
    });
    expect(compose.services.web?.depends_on?.api?.condition).toBe('service_started');
    expect(compose.services.web?.environment).toMatchObject({
      ORIGIN: '${WEB_ORIGIN:-http://localhost:3000}',
      WEB_ORIGIN: '${WEB_ORIGIN:-http://localhost:3000}',
    });
    expect(compose.services.api?.build?.dockerfile).toBe('apps/api/Dockerfile');
    expect(compose.services.web?.build?.dockerfile).toBe('apps/web/Dockerfile');

    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.api?.ports).toEqual([
      '${OPENBOT_BIND_ADDRESS:-127.0.0.1}:${API_PORT:-3001}:3001',
    ]);
    expect(compose.services.web?.ports).toEqual([
      '${OPENBOT_BIND_ADDRESS:-127.0.0.1}:${WEB_PORT:-3000}:3000',
    ]);
    expect(compose.services.postgres?.entrypoint?.join('\n')).toContain(
      'OPENBOT_ALLOW_INSECURE_LOCAL_PASSWORD',
    );
    expect(compose.services.postgres?.networks).toEqual(['data']);
    expect(compose.services.migrate?.networks).toEqual(['data']);
    expect(compose.services.api?.networks).toEqual(['data', 'frontend']);
    expect(compose.services.worker?.networks).toEqual(['data', 'frontend']);
    expect(compose.services.web?.networks).toEqual(['frontend']);
    expect(compose.networks?.data).toEqual({ internal: true });
    expect(compose.networks?.frontend).toBeNull();
    expect(compose.services.migrate?.environment).toMatchObject({
      OPENBOT_ALLOW_INSECURE_LOCAL_PASSWORD: '${OPENBOT_ALLOW_INSECURE_LOCAL_PASSWORD:-false}',
      OPENBOT_DATABASE_PASSWORD:
        '${OPENBOT_DATABASE_PASSWORD:?set OPENBOT_DATABASE_PASSWORD in .env}',
      PGDATABASE: '${POSTGRES_DB:-openbot}',
      PGHOST: 'postgres',
      PGPASSWORD: '${POSTGRES_PASSWORD:-replace-me}',
      PGPORT: 5432,
      PGUSER: '${POSTGRES_USER:-openbot}',
    });
    expect(compose.services.api?.environment).toMatchObject({
      API_HOST: '0.0.0.0',
      OPENBOT_SETUP_TOKEN: '${OPENBOT_SETUP_TOKEN:?set OPENBOT_SETUP_TOKEN in .env}',
      PGDATABASE: '${POSTGRES_DB:-openbot}',
      PGHOST: 'postgres',
      PGPASSWORD: '${OPENBOT_DATABASE_PASSWORD:?set OPENBOT_DATABASE_PASSWORD in .env}',
      PGPORT: 5432,
      PGUSER: 'openbot_runtime',
    });
    expect(compose.services.web?.environment).toMatchObject({
      HOST: '0.0.0.0',
      ORIGIN: '${WEB_ORIGIN:-http://localhost:3000}',
      WEB_ORIGIN: '${WEB_ORIGIN:-http://localhost:3000}',
    });
    for (const serviceName of ['migrate', 'api', 'worker']) {
      expect(compose.services[serviceName]?.environment).not.toHaveProperty('DATABASE_URL');
    }
    expect(compose.services.migrate?.command).toEqual([
      '/bin/sh',
      '-ec',
      'node dist/database/migrate.js && node /app/grant-runtime-privileges.mjs',
    ]);
    expect(compose.services.migrate?.volumes).toContain(
      './infra/postgres/grant-runtime-privileges.mjs:/app/grant-runtime-privileges.mjs:ro',
    );

    for (const serviceName of ['migrate', 'api', 'worker', 'web']) {
      expect(compose.services[serviceName]?.read_only).toBe(true);
      expect(compose.services[serviceName]?.cap_drop).toEqual(['ALL']);
      expect(compose.services[serviceName]?.security_opt).toContain('no-new-privileges:true');
      expect(compose.services[serviceName]?.tmpfs).toContain('/tmp:size=64m,mode=1777');
    }
  });

  it('provisions the API database role with only its required privileges', () => {
    const grants = readFileSync(
      `${repositoryRoot}/infra/postgres/grant-runtime-privileges.mjs`,
      'utf8',
    );

    expect(grants).toContain("set_config('openbot.runtime_password', $1, true)");
    expect(grants).toContain('CREATE ROLE openbot_runtime');
    expect(grants).toContain('ALTER ROLE openbot_runtime');
    expect(grants).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION');
    expect(grants).toContain("current_user = 'openbot_runtime'");
    expect(grants).toContain("CONNECTION LIMIT -1 VALID UNTIL ''infinity''");
    expect(grants).toContain('ALTER ROLE openbot_runtime RESET ALL');
    expect(grants).toContain('ALTER ROLE openbot_runtime IN DATABASE');
    expect(grants).toContain('SET search_path TO pg_catalog, public');
    expect(grants).toContain('FROM pg_catalog.pg_auth_members');
    expect(grants).toContain("member_role.rolname = 'openbot_runtime'");
    expect(grants).toContain("format('REVOKE %I FROM openbot_runtime', granted_role.rolname)");
    expect(grants).toContain('FROM pg_catalog.pg_database');
    expect(grants).toContain('FROM pg_catalog.pg_namespace');
    expect(grants).toContain('FROM pg_catalog.pg_class');
    expect(grants).toContain('FROM pg_catalog.pg_proc');
    expect(grants).toContain('Failed to configure openbot_runtime role');
    expect(grants).toContain('Runtime database privilege provisioning failed');
    expect(grants).not.toContain('throw error');
    expect(grants).toContain('GRANT INSERT ON audit_events TO openbot_runtime');
    expect(grants).toContain('GRANT SELECT, INSERT ON api_tokens TO openbot_runtime');
    expect(grants).toContain(
      'GRANT UPDATE (last_used_at, revoked_at) ON api_tokens TO openbot_runtime',
    );
    expect(grants).not.toContain('GRANT UPDATE ON api_tokens');
    expect(grants).not.toContain('GRANT DELETE ON api_tokens');
    expect(grants).toContain('GRANT UPDATE (name, description) ON workspaces TO openbot_runtime');
    expect(grants).toContain('GRANT UPDATE (owner_user_id) ON instance_claims TO openbot_runtime');
    expect(grants).toContain('GRANT UPDATE (revoked_at) ON sessions TO openbot_runtime');
    expect(grants).toContain('REVOKE ALL ON audit_events FROM openbot_runtime');
    expect(grants).toContain('REVOKE ALL PRIVILEGES ON DATABASE %I FROM openbot_runtime');
    expect(grants).toContain('REVOKE ALL ON SCHEMA public FROM openbot_runtime');
    expect(grants).toContain(
      'REVOKE ALL ON FUNCTION reject_audit_event_mutation() FROM openbot_runtime',
    );
    expect(grants).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    expect(grants).not.toContain('GRANT UPDATE ON audit_events');
    expect(grants).not.toContain('GRANT DELETE ON audit_events');
    expect(grants).not.toContain('GRANT TRUNCATE ON audit_events');
  });

  it('builds minimal production containers that run as an unprivileged user', () => {
    const apiDockerfile = readFileSync(`${repositoryRoot}/apps/api/Dockerfile`, 'utf8');
    const webDockerfile = readFileSync(`${repositoryRoot}/apps/web/Dockerfile`, 'utf8');

    expect(apiDockerfile.match(/^FROM /gm)).toHaveLength(2);
    expect(apiDockerfile).toContain('AS build');
    expect(apiDockerfile).toContain('pnpm --filter @openbot/api deploy --prod --legacy /runtime');
    expect(apiDockerfile).toContain(
      'COPY --from=build --chown=node:node /runtime/node_modules ./node_modules',
    );
    expect(apiDockerfile).toContain(
      'COPY --from=build --chown=node:node /app/apps/api/dist ./dist',
    );
    expect(apiDockerfile).toContain('USER node');
    expect(apiDockerfile).toContain('CMD ["node", "dist/server.js"]');

    expect(webDockerfile.match(/^FROM /gm)).toHaveLength(2);
    expect(webDockerfile).toContain('AS build');
    expect(webDockerfile).toContain('COPY --from=build --chown=node:node /app/apps/web/build ./');
    expect(webDockerfile).toContain('USER node');
    expect(webDockerfile).toContain('CMD ["node", "index.js"]');
  });

  it('documents the fresh-checkout startup and verification commands', () => {
    const readme = readFileSync(`${repositoryRoot}/README.md`, 'utf8');

    expect(readme).toContain('cp .env.example .env');
    expect(readme).toContain('docker compose up --build');
    expect(readme).toContain('pnpm verify');
    expect(readme).toContain('http://localhost:3000');
    expect(readme).toContain('http://localhost:3001/api/v1/status');
    expect(readme).toContain('OPENBOT_BIND_ADDRESS');
    expect(readme).toContain('high-entropy');
    expect(readme).toContain(
      'does not start during initial stack startup until the migration and privilege gate succeeds',
    );
    expect(readme).toContain('maintenance window that restarts the API');
    expect(readme).toContain('during a later database');
    expect(readme).toContain('outage');
  });

  it('runs both the code gate and Compose smoke test in CI', () => {
    const workflow = readFileSync(`${repositoryRoot}/.github/workflows/verify.yml`, 'utf8');

    expect(workflow).toContain('pnpm verify');
    expect(workflow).toContain('postgres-auth:');
    expect(workflow).toContain('pnpm --filter @openbot/api run test:postgres');
    expect(workflow).toContain('docker compose up --build --detach');
    expect(workflow).toContain('Verify a fresh database volume before the upgrade path');
    expect(workflow).toContain('api_started_at');
    expect(workflow).toContain('migration_finished_at');
    expect(workflow).toContain('0001_bootstrap');
    expect(workflow).toContain('0002_local_owner_auth');
    expect(workflow).toContain('DROP ROLE IF EXISTS openbot_runtime');
    expect(workflow).toContain('CREATE ROLE openbot_runtime_elevated');
    expect(workflow).toContain('GRANT openbot_runtime_elevated TO openbot_runtime');
    expect(workflow).toContain('Verify a failed role downgrade does not disclose its password');
    expect(workflow).toContain('ci-secret-must-not-appear-in-logs');
    expect(workflow).toContain('ci-rotated-runtime-password');
    expect(workflow).toContain('ALTER ROLE openbot_runtime WITH SUPERUSER');
    expect(workflow).not.toContain('docker compose up --build --wait');
    expect(workflow).toContain("docker inspect --format '{{.State.Status}}'");
    expect(workflow).toContain("docker inspect --format '{{.State.ExitCode}}'");
    expect(workflow).toContain('"status":"ready"');
    expect(workflow).toContain('data-state="ready"');
    expect(workflow).toContain('Verify the real local-owner session lifecycle');
    expect(workflow).toContain('instance_already_claimed');
    expect(workflow).toContain('invalid_origin');
    expect(workflow).toContain('auth.signed_out');
    expect(workflow).toContain("--header 'X-OpenBot-Setup-Token:");
    expect(workflow).toContain('openbot_runtime');
    expect(workflow).toContain('membership_count');
    expect(workflow).toContain('SET ROLE openbot_runtime_elevated');
    expect(workflow).toContain('pg_database_owner');
    expect(workflow).toContain('runtime_owned_objects');
    expect(workflow).toContain('role_settings');
    expect(workflow).toContain("has_schema_privilege('openbot_runtime', 'public', 'USAGE')");
    expect(workflow).toContain(
      "has_table_privilege('openbot_runtime', 'openbot_schema_migrations', 'INSERT')",
    );
    expect(workflow).toContain(
      "has_column_privilege('openbot_runtime', 'instance_claims', 'owner_user_id', 'UPDATE')",
    );
    expect(workflow).toContain(
      "has_column_privilege('openbot_runtime', 'sessions', 'token_digest', 'UPDATE')",
    );
    expect(workflow).toContain("UPDATE audit_events SET metadata = '{}'::jsonb");
    expect(workflow).toContain('DELETE FROM audit_events');
    expect(workflow).toContain('TRUNCATE TABLE audit_events');
    expect(workflow).toContain("has_table_privilege('openbot_runtime', 'audit_events', 'UPDATE')");
    expect(workflow).toContain("has_database_privilege('openbot_runtime', current_database()");
    expect(workflow).toContain("has_function_privilege('openbot_runtime'");
    expect(workflow).toContain('DROP TRIGGER audit_events_append_only ON audit_events');
    expect(workflow).toContain('docker compose stop postgres');
    expect(workflow).toContain('503');
    expect(workflow).toContain('"status":"unavailable"');
    expect(workflow).toContain('data-state="unavailable"');
    expect(workflow).toContain('docker compose down --volumes');
  });
});

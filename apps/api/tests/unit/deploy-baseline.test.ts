import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { readTelemetryConfig } from '../../src/telemetry/config.js';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

type ComposeService = {
  command?: string | string[];
  depends_on?: Record<string, { condition: string }>;
  environment?: Record<string, string | number>;
  healthcheck?: { test?: string | string[]; interval?: string; timeout?: string; retries?: number };
  networks?: string[];
  ports?: string[];
  restart?: string;
  volumes?: string[];
};

type ComposeFile = {
  networks?: Record<string, { internal?: boolean } | null>;
  services: Record<string, ComposeService>;
  volumes?: Record<string, null | Record<string, unknown>>;
};

function readCompose(): ComposeFile {
  return parse(readFileSync(`${repositoryRoot}/compose.yaml`, 'utf8')) as ComposeFile;
}

function readExampleEnvironment(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(`${repositoryRoot}/.env.example`, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('DEPLOY-01 single-host Compose baseline contracts', () => {
  it('keeps telemetry disabled in the documented Compose defaults', () => {
    const environment = readExampleEnvironment();
    expect(environment.OPENBOT_TELEMETRY).toBe('false');
    expect(readTelemetryConfig(environment).enabled).toBe(false);

    const compose = readCompose();
    expect(compose.services.api?.environment?.OPENBOT_TELEMETRY).toBe(
      '${OPENBOT_TELEMETRY:-false}',
    );
    expect(compose.services.worker?.environment?.OPENBOT_TELEMETRY).toBe(
      '${OPENBOT_TELEMETRY:-false}',
    );
  });

  it('does not publish PostgreSQL or worker-only ports on the host interface', () => {
    const compose = readCompose();
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.worker?.ports).toBeUndefined();
    expect(compose.services.migrate?.ports).toBeUndefined();
    expect(compose.services.api?.ports).toEqual([
      '${OPENBOT_BIND_ADDRESS:-127.0.0.1}:${API_PORT:-3001}:3001',
    ]);
    expect(compose.services.web?.ports).toEqual([
      '${OPENBOT_BIND_ADDRESS:-127.0.0.1}:${WEB_PORT:-3000}:3000',
    ]);
  });

  it('declares healthchecks and first-admin bootstrap for one-command healthy startup', () => {
    const compose = readCompose();
    const readme = readFileSync(`${repositoryRoot}/README.md`, 'utf8');

    expect(Object.keys(compose.services)).toEqual(['postgres', 'migrate', 'api', 'worker', 'web']);
    expect(compose.services.postgres?.healthcheck?.test?.[0]).toBe('CMD-SHELL');
    expect(compose.services.api?.healthcheck?.test).toEqual([
      'CMD',
      'node',
      '-e',
      "fetch('http://127.0.0.1:3001/api/v1/status').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))",
    ]);
    expect(compose.services.web?.healthcheck?.test).toEqual([
      'CMD',
      'node',
      '-e',
      "fetch('http://127.0.0.1:3000').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))",
    ]);
    expect(compose.services.worker?.healthcheck?.test).toEqual([
      'CMD-SHELL',
      'pidof node >/dev/null',
    ]);
    expect(compose.services.worker?.ports).toBeUndefined();

    expect(compose.services.api?.depends_on).toEqual({
      migrate: { condition: 'service_completed_successfully' },
    });
    expect(compose.services.worker?.depends_on).toEqual({
      migrate: { condition: 'service_completed_successfully' },
    });
    expect(compose.services.web?.depends_on).toEqual({
      api: { condition: 'service_healthy' },
    });
    expect(compose.services.api?.environment?.OPENBOT_SETUP_TOKEN).toBe(
      '${OPENBOT_SETUP_TOKEN:?set OPENBOT_SETUP_TOKEN in .env}',
    );

    expect(readme).toContain('cp .env.example .env');
    expect(readme).toContain('docker compose up --build');
    expect(readme).toContain('http://localhost:3000/setup');
    expect(readme).toContain('OPENBOT_SETUP_TOKEN');
    expect(readme).toContain('first setup');
    expect(readme).toContain('worker');
    expect(readme).toContain('healthy');
  });

  it('runs the migration service once and blocks API readiness until it succeeds', () => {
    const compose = readCompose();
    const readme = readFileSync(`${repositoryRoot}/README.md`, 'utf8');
    const migrations = readFileSync(
      `${repositoryRoot}/apps/api/src/database/migrations.ts`,
      'utf8',
    );

    expect(compose.services.migrate?.restart).toBe('no');
    expect(compose.services.migrate?.command).toEqual([
      '/bin/sh',
      '-ec',
      'node dist/database/migrate.js && node /app/grant-runtime-privileges.mjs',
    ]);
    expect(compose.services.migrate?.depends_on?.postgres?.condition).toBe('service_healthy');
    expect(compose.services.api?.depends_on?.migrate?.condition).toBe(
      'service_completed_successfully',
    );
    expect(compose.services.worker?.depends_on?.migrate?.condition).toBe(
      'service_completed_successfully',
    );
    expect(migrations).toContain('pg_advisory_xact_lock(hashtext($1))');
    expect(migrations).toContain('openbot:schema-migrations');

    expect(readme).toContain('one-shot, idempotent migration');
    expect(readme).toContain(
      'does not start during initial stack startup until the migration and privilege gate succeeds',
    );
    expect(readme).toContain('readiness endpoint reports `Unavailable`');
  });

  it('keeps named volumes so restarting containers preserves durable state', () => {
    const compose = readCompose();
    const readme = readFileSync(`${repositoryRoot}/README.md`, 'utf8');

    expect(compose.volumes).toEqual({
      'object-data': null,
      'postgres-data': null,
    });
    expect(compose.services.postgres?.volumes).toEqual(['postgres-data:/var/lib/postgresql/data']);
    expect(compose.services.api?.volumes).toEqual(['object-data:/var/lib/openbot/objects']);
    expect(compose.services.worker?.volumes).toEqual(['object-data:/var/lib/openbot/objects']);

    expect(readme).toContain('docker compose down');
    expect(readme).toContain('--volumes');
    expect(readme).toContain('object-data');
    expect(readme).toContain('preserves users, workspaces, task state, and attachments');
  });

  it('supports private-network model endpoints without publishing provider services', () => {
    const compose = readCompose();
    const environment = readExampleEnvironment();
    const readme = readFileSync(`${repositoryRoot}/README.md`, 'utf8');

    expect(compose.services).not.toHaveProperty('task-provider');
    expect(compose.services).not.toHaveProperty('model');
    expect(compose.services).not.toHaveProperty('ollama');
    expect(compose.networks?.data).toEqual({ internal: true });
    expect(compose.services.api?.networks).toEqual(['data', 'frontend']);
    expect(compose.services.worker?.networks).toEqual(['data', 'frontend']);
    expect(compose.services.api?.environment?.OPENBOT_PROVIDER_ALLOWED_HOSTS).toBe(
      '${OPENBOT_PROVIDER_ALLOWED_HOSTS:-api.openai.com}',
    );
    expect(compose.services.api?.environment?.OPENBOT_PROVIDER_ALLOWED_SCHEMES).toBe(
      '${OPENBOT_PROVIDER_ALLOWED_SCHEMES:-https}',
    );
    expect(compose.services.api?.environment?.OPENBOT_PROVIDER_PRIVATE_CIDRS).toBe(
      '${OPENBOT_PROVIDER_PRIVATE_CIDRS:-}',
    );
    expect(compose.services.worker?.environment?.OPENBOT_PROVIDER_ALLOWED_HOSTS).toBe(
      '${OPENBOT_PROVIDER_ALLOWED_HOSTS:-api.openai.com}',
    );
    expect(compose.services.worker?.environment?.OPENBOT_PROVIDER_ALLOWED_SCHEMES).toBe(
      '${OPENBOT_PROVIDER_ALLOWED_SCHEMES:-https}',
    );
    expect(compose.services.worker?.environment?.OPENBOT_PROVIDER_PRIVATE_CIDRS).toBe(
      '${OPENBOT_PROVIDER_PRIVATE_CIDRS:-}',
    );
    expect(environment.OPENBOT_PROVIDER_PRIVATE_CIDRS).toBe('');
    expect(environment.OPENBOT_PROVIDER_ALLOWED_HOSTS).toBe('api.openai.com');

    expect(readme).toContain('OPENBOT_PROVIDER_PRIVATE_CIDRS');
    expect(readme).toContain('private network');
    expect(readme).toContain('without publishing a model service');
  });
});

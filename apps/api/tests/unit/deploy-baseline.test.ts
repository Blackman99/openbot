import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { readTelemetryConfig } from '../../src/telemetry/config.js';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

describe('DEPLOY-01 single-host Compose baseline contracts', () => {
  it('keeps telemetry disabled in the documented Compose defaults', () => {
    const environment = Object.fromEntries(
      readFileSync(`${repositoryRoot}/.env.example`, 'utf8')
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(environment.OPENBOT_TELEMETRY).toBe('false');
    expect(readTelemetryConfig(environment).enabled).toBe(false);

    const compose = parse(readFileSync(`${repositoryRoot}/compose.yaml`, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string | number>; ports?: string[] }>;
    };
    expect(compose.services.api?.environment?.OPENBOT_TELEMETRY).toBe(
      '${OPENBOT_TELEMETRY:-false}',
    );
    expect(compose.services.worker?.environment?.OPENBOT_TELEMETRY).toBe(
      '${OPENBOT_TELEMETRY:-false}',
    );
  });

  it('does not publish PostgreSQL or worker-only ports on the host interface', () => {
    const compose = parse(readFileSync(`${repositoryRoot}/compose.yaml`, 'utf8')) as {
      services: Record<string, { ports?: string[] }>;
    };
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
});

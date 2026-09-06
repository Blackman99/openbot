import type { Environment } from '../config.js';

export interface TelemetryConfig {
  enabled: boolean;
}

export interface Telemetry {
  enabled: boolean;
  record(event: string, attributes?: Readonly<Record<string, string>>): void;
}

function normalizeFlag(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === '0' || normalized === 'false' || normalized === 'off') {
    return false;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'on') {
    return true;
  }
  return undefined;
}

/** Telemetry stays off unless OPENBOT_TELEMETRY explicitly enables it. */
export function readTelemetryConfig(environment: Environment): TelemetryConfig {
  const raw = environment.OPENBOT_TELEMETRY;
  if (raw === undefined) {
    return { enabled: false };
  }
  const enabled = normalizeFlag(raw);
  if (enabled === undefined) {
    throw new Error('OPENBOT_TELEMETRY must be true or false');
  }
  return { enabled };
}

/**
 * First DEPLOY-01 slice: even an explicitly enabled flag constructs only a local
 * no-op recorder. No exporter, HTTP client, or phone-home path is registered.
 */
export function createTelemetry(config: TelemetryConfig): Telemetry {
  return {
    enabled: config.enabled,
    record() {},
  };
}

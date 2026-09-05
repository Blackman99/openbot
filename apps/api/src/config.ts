import { createHash } from 'node:crypto';

export type Environment = Readonly<Record<string, string | undefined>>;

export type DatabaseConnectionOptions =
  | Readonly<{ connectionString: string }>
  | Readonly<{
      database: string;
      host: string;
      password: string;
      port: number;
      user: string;
    }>;

export interface ApiConfig {
  database: DatabaseConnectionOptions;
  databaseConnectionTimeoutMs: number;
  databaseQueryTimeoutMs: number;
  host: string;
  port: number;
  setupTokenDigest: string;
  webOrigin: string;
}

const DOCUMENTED_LOCAL_SETUP_TOKEN = 'local-only-openbot-setup-token-change-me';

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function readInteger(
  environment: Environment,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }

  return value;
}

function readDatabaseUrl(value: string): DatabaseConnectionOptions {
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new Error('unsupported protocol');
    }

    return { connectionString: value };
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
}

export function readDatabaseConfig(environment: Environment): DatabaseConnectionOptions {
  if (environment.DATABASE_URL) {
    return readDatabaseUrl(environment.DATABASE_URL);
  }

  const { PGDATABASE, PGHOST, PGPASSWORD, PGUSER } = environment;
  if (!PGDATABASE || !PGHOST || !PGPASSWORD || !PGUSER) {
    throw new Error('DATABASE_URL or PGHOST, PGUSER, PGPASSWORD, and PGDATABASE is required');
  }

  return {
    database: PGDATABASE,
    host: PGHOST,
    password: PGPASSWORD,
    port: readInteger(environment, 'PGPORT', 5432, 65_535),
    user: PGUSER,
  };
}

function readWebOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('WEB_ORIGIN must be a valid HTTP(S) origin');
  }

  const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
  const isOriginOnly =
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  if (!isHttp || !isOriginOnly) {
    throw new Error('WEB_ORIGIN must be a valid HTTP(S) origin');
  }

  const isLoopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new Error('WEB_ORIGIN must use HTTPS unless it is loopback');
  }

  return url.origin;
}

function readSetupTokenDigest(value: string | undefined, webOrigin: string): string {
  const bytes = value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
  if (value === undefined || bytes < 32 || bytes > 1_024) {
    throw new Error('OPENBOT_SETUP_TOKEN must be between 32 and 1024 bytes');
  }

  if (value === DOCUMENTED_LOCAL_SETUP_TOKEN && !isLoopbackHostname(new URL(webOrigin).hostname)) {
    throw new Error(
      'OPENBOT_SETUP_TOKEN must not use the documented local-development value for a non-loopback WEB_ORIGIN',
    );
  }

  return createHash('sha256').update(value).digest('hex');
}

export function readApiConfig(environment: Environment): ApiConfig {
  const host = environment.API_HOST ?? '0.0.0.0';
  if (host.trim() === '') {
    throw new Error('API_HOST must not be empty');
  }

  // Validate the public boundary independently from secrets so operators get the
  // most actionable configuration error first.
  const webOrigin = readWebOrigin(environment.WEB_ORIGIN ?? 'http://localhost:3000');

  return {
    database: readDatabaseConfig(environment),
    databaseConnectionTimeoutMs: readInteger(
      environment,
      'DATABASE_CONNECTION_TIMEOUT_MS',
      1_000,
      300_000,
    ),
    databaseQueryTimeoutMs: readInteger(environment, 'DATABASE_QUERY_TIMEOUT_MS', 1_000, 300_000),
    host,
    port: readInteger(environment, 'API_PORT', 3001, 65_535),
    setupTokenDigest: readSetupTokenDigest(environment.OPENBOT_SETUP_TOKEN, webOrigin),
    webOrigin,
  };
}

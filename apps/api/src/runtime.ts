import cors, { type FastifyCorsOptionsDelegate } from '@fastify/cors';
import pg, { type PoolConfig } from 'pg';

import { buildApp } from './app.js';
import { PostgresAuthRepository } from './auth/postgres-auth-repository.js';
import { LocalAuthService } from './auth/service.js';
import { PostgresWorkspaceRepository } from './workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from './workspaces/service.js';
import type { DatabaseConnectionOptions } from './config.js';
import { MIGRATION_VERSIONS } from './database/migrations.js';
import {
  PostgresReadinessProbe,
  type DatabaseClient,
  type DatabaseQueryResult,
} from './database/readiness.js';

const { Pool } = pg;

export interface ProductionAppOptions {
  database: DatabaseConnectionOptions;
  databaseConnectionTimeoutMs: number;
  databaseQueryTimeoutMs: number;
  logger?: boolean;
  setupTokenDigest: string;
  webOrigin: string;
}

export function buildProductionApp(options: ProductionAppOptions) {
  const poolConfig: PoolConfig = {
    ...options.database,
    connectionTimeoutMillis: options.databaseConnectionTimeoutMs,
    query_timeout: options.databaseQueryTimeoutMs,
  };
  const pool = new Pool(poolConfig);
  const database: DatabaseClient = {
    query: async <Row extends Record<string, unknown>>(
      statement: string,
      parameters?: unknown[],
    ): Promise<DatabaseQueryResult<Row>> => {
      const result = await pool.query<Row>(statement, parameters);
      return { rows: result.rows };
    },
  };
  const readiness = new PostgresReadinessProbe(database, MIGRATION_VERSIONS);
  const auth = new LocalAuthService(new PostgresAuthRepository(pool));
  const corsOptions: FastifyCorsOptionsDelegate = (request, callback) => {
    const trustedOrigin = request.headers.origin === options.webOrigin;
    callback(null, {
      allowedHeaders: ['Content-Type', 'X-OpenBot-Setup-Token'],
      credentials: trustedOrigin,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      origin: trustedOrigin,
    });
  };
  const app = buildApp({
    auth,
    workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
    readiness,
    setupTokenDigest: options.setupTokenDigest,
    webOrigin: options.webOrigin,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  void app.register(cors, () => corsOptions);
  pool.on('error', () => {
    app.log.error('Idle PostgreSQL connection failed');
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}

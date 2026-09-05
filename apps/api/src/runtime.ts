import { OpenIdProvider } from './oidc/provider.js';
import { PostgresOidcRepository } from './oidc/postgres-repository.js';
import { OidcService } from './oidc/service.js';
import type { OidcConfig } from './oidc/config.js';
import cors, { type FastifyCorsOptionsDelegate } from '@fastify/cors';
import pg, { type PoolConfig } from 'pg';

import { InvitationService } from './invitations/service.js';
import { PostgresInvitationRepository } from './invitations/postgres-invitation-repository.js';
import { WorkspaceMemberService } from './members/service.js';
import { PostgresWorkspaceMemberRepository } from './members/postgres-member-repository.js';
import { buildApp } from './app.js';
import { PostgresAuthRepository } from './auth/postgres-auth-repository.js';
import { LocalAuthService } from './auth/service.js';
import type { ProviderConfig } from './providers/config.js';
import { ProviderConnections } from './providers/connections.js';
import { ProtocolConnectionProbe } from './providers/protocols.js';
import { PostgresProviderRepository } from './providers/postgres-repository.js';
import { ProviderSecretBox } from './providers/secrets.js';
import { ProviderUrlPolicy } from './providers/url-policy.js';
import { PostgresWorkspaceRepository } from './workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from './workspaces/service.js';
import { GroupService } from './groups/service.js';
import { PostgresGroupRepository } from './groups/postgres-group-repository.js';
import type { DatabaseConnectionOptions } from './config.js';
import { MIGRATION_VERSIONS } from './database/migrations.js';
import {
  PostgresReadinessProbe,
  type DatabaseClient,
  type DatabaseQueryResult,
} from './database/readiness.js';

const { Pool } = pg;

export interface ProductionAppOptions {
  oidc?: OidcConfig;
  database: DatabaseConnectionOptions;
  databaseConnectionTimeoutMs: number;
  databaseQueryTimeoutMs: number;
  logger?: boolean;
  setupTokenDigest: string;
  webOrigin: string;
  providers?: ProviderConfig;
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
  const providerOptions = options.providers;
  const policy = providerOptions ? new ProviderUrlPolicy(providerOptions.network) : undefined;
  const providers =
    providerOptions && policy
      ? new ProviderConnections(
          new PostgresProviderRepository(pool),
          new ProviderSecretBox(providerOptions.encryptionKey),
          policy,
          new ProtocolConnectionProbe(policy),
        )
      : undefined;
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
    groups: new GroupService(new PostgresGroupRepository(pool)),
    members: new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(pool)),
    ...(options.oidc
      ? {
          oidc: new OidcService(
            auth,
            new PostgresOidcRepository(pool),
            new OpenIdProvider(options.oidc),
            options.oidc.issuer,
            options.oidc.callbackUrl,
          ),
        }
      : {}),
    ...(providers ? { providers } : {}),
    invitations: new InvitationService(new PostgresInvitationRepository(pool)),
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

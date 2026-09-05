import { BotCopyService } from './bots/copy-service.js';
import { MemoryService } from './memories/service.js';
import { AttachmentService } from './attachments/service.js';
import { KnowledgeService } from './knowledge/service.js';
import { attachmentLimit } from './attachments/types.js';
import { BotVersionService } from './bots/version-service.js';
import { TaskService } from './tasks/service.js';
import { GroupRoutingService } from './routing/service.js';
import { BotAvatarService } from './bots/avatar-service.js';
import { startAvatarCleanup } from './bots/avatar-cleanup.js';
import { createObjectStore, type ObjectStorageConfig } from './objects/config.js';
import { S3ObjectStore } from './objects/s3-store.js';
import { BotService } from './bots/service.js';
import { BotLifecycleService } from './bots/lifecycle-service.js';
import { BotAclService } from './bots/acl-service.js';
import { PostgresBotAclRepository } from './bots/postgres-bot-acl-repository.js';
import { ConversationService } from './conversations/service.js';
import { PostgresConversationRepository } from './conversations/postgres-repository.js';
import { ConversationStreamService } from './conversations/stream-service.js';
import { startConversationStreamCleanup } from './conversations/stream-cleanup.js';
import { PostgresBotRepository } from './bots/postgres-bot-repository.js';
import { OpenIdProvider } from './oidc/provider.js';
import { PostgresOidcRepository } from './oidc/postgres-repository.js';
import { OidcService } from './oidc/service.js';
import type { OidcConfig } from './oidc/config.js';
import cors, { type FastifyCorsOptionsDelegate } from '@fastify/cors';
import pg, { type PoolConfig } from 'pg';

import { ApiTokenService } from './api-tokens/service.js';
import { PostgresApiTokenRepository } from './api-tokens/postgres-repository.js';
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
import { GroupBotService } from './group-bots/service.js';
import { PostgresGroupBotRepository } from './group-bots/postgres-repository.js';
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
  objectStorage?: ObjectStorageConfig;
  attachmentMaxBytes?: number;
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
  const objectStore = createObjectStore(
    options.objectStorage ?? { backend: 'local', rootDirectory: '/var/lib/openbot/objects' },
  );
  const attachmentMaxBytes = attachmentLimit(options.attachmentMaxBytes);
  const attachmentStore = createObjectStore(
    options.objectStorage ?? { backend: 'local', rootDirectory: '/var/lib/openbot/objects' },
    { maxObjectBytes: attachmentMaxBytes },
  );
  const attachments = new AttachmentService(pool, attachmentStore, attachmentMaxBytes);
  const avatars = new BotAvatarService(pool, objectStore);
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
    avatars,
    attachments,
    knowledge: new KnowledgeService(pool, attachments),
    memories: new MemoryService(pool),
    conversations: new ConversationService(new PostgresConversationRepository(pool)),
    conversationStreams: new ConversationStreamService(pool),
    tasks: new TaskService(pool),
    groupRouting: new GroupRoutingService(pool),
    botVersions: new BotVersionService(pool, avatars),
    botCopies: new BotCopyService(pool),
    bots: new BotService(new PostgresBotRepository(pool)),
    botAcl: new BotAclService(new PostgresBotAclRepository(pool)),
    botLifecycle: new BotLifecycleService(pool),
    groups: new GroupService(new PostgresGroupRepository(pool)),
    groupBots: new GroupBotService(new PostgresGroupBotRepository(pool)),
    apiTokens: new ApiTokenService(new PostgresApiTokenRepository(pool)),
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
  let stopCleanup: (() => Promise<void>) | undefined;
  let stopAttachmentCleanup: (() => Promise<void>) | undefined;
  let stopStreamCleanup: (() => Promise<void>) | undefined;
  app.addHook('onReady', async () => {
    stopStreamCleanup = startConversationStreamCleanup(pool, () =>
      app.log.error('Conversation delivery cleanup failed'),
    );
    stopAttachmentCleanup = startAvatarCleanup(
      () => attachments.cleanup(5),
      () => app.log.error('Attachment object cleanup failed'),
    );
    stopCleanup = startAvatarCleanup(
      () => avatars.cleanup(5),
      () => app.log.error('Avatar object cleanup failed'),
    );
  });
  app.addHook('onClose', async () => {
    await stopStreamCleanup?.();
    await stopCleanup?.();
    await stopAttachmentCleanup?.();
    if (attachmentStore instanceof S3ObjectStore) attachmentStore.destroy();
    if (objectStore instanceof S3ObjectStore) objectStore.destroy();
    await pool.end();
  });

  return app;
}

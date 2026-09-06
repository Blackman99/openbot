import { registerBotCopyRoutes } from './bots/copy-routes.js';
import type { BotCopyService } from './bots/copy-service.js';
import { registerBotTemplateRoutes } from './bots/template-routes.js';
import type { BotTemplateService } from './bots/template-service.js';
import { registerAttachmentRoutes } from './attachments/routes.js';
import { registerKnowledgeRoutes } from './knowledge/routes.js';
import { registerMemoryRoutes } from './memories/routes.js';
import type { MemoryService } from './memories/service.js';
import type { AttachmentService } from './attachments/service.js';
import type { KnowledgeService } from './knowledge/service.js';
import { registerBotVersionRoutes } from './bots/version-routes.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { registerExecutionLimitRoutes } from './tasks/limit-routes.js';
import type { ExecutionLimitService } from './tasks/limit-policy.js';
import type { TaskService } from './tasks/service.js';
import type { GroupRoutingService } from './routing/service.js';
import { registerGroupRoutingRoutes } from './routing/routes.js';
import type { BotVersionService } from './bots/version-service.js';
import { registerBotRoutes } from './bots/routes.js';
import { registerPublicBotRoutes } from './bots/public-routes.js';
import { registerBotLifecycleRoutes } from './bots/lifecycle-routes.js';
import type { BotLifecycleService } from './bots/lifecycle-service.js';
import { registerBotAclRoutes } from './bots/acl-routes.js';
import type { BotAclService } from './bots/acl-service.js';
import { registerBotAvatarRoutes } from './bots/avatar-routes.js';
import type { BotAvatarService } from './bots/avatar-service.js';
import { registerConversationRoutes } from './conversations/routes.js';
import { registerConversationStreamRoutes } from './conversations/stream-routes.js';
import type { ConversationStreams } from './conversations/stream-delivery.js';
import type { ConversationService } from './conversations/service.js';
import type { BotService } from './bots/service.js';
import { registerOidcRoutes } from './oidc/routes.js';
import type { OidcService } from './oidc/service.js';
import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { registerApiTokenRoutes, registerPublicIdentityRoute } from './api-tokens/routes.js';
import type { ApiTokenService } from './api-tokens/service.js';
import { AuthenticationAttemptLimiter } from './auth/attempt-limiter.js';
import { InstanceAlreadyClaimedError } from './auth/repository.js';
import { readSessionToken, serializeSessionCookie } from './auth/session-cookie.js';
import {
  AuthenticationBusyError,
  InvalidAuthInputError,
  InvalidCredentialsError,
  type AuthenticatedSession,
  type AuthService,
  type SetupInput,
  type SignInInput,
} from './auth/service.js';
import { registerInvitationRoutes } from './invitations/routes.js';
import type { InvitationService } from './invitations/service.js';
import { registerWorkspaceMemberRoutes } from './members/routes.js';
import type { WorkspaceMemberService } from './members/service.js';
import { registerGroupRoutes } from './groups/routes.js';
import type { GroupService } from './groups/service.js';
import type { GroupBotService } from './group-bots/service.js';
import { registerGroupBotRoutes } from './group-bots/routes.js';
import type { ReadinessProbe } from './readiness.js';
import type { ProviderConnections } from './providers/connections.js';
import { registerProviderRoutes } from './providers/routes.js';
import { registerWorkspaceRoutes } from './workspaces/routes.js';
import type { WorkspaceService } from './workspaces/service.js';

export interface BuildAppOptions {
  memories?: MemoryService;
  conversationStreams?: ConversationStreams;
  tasks?: TaskService;
  executionLimits?: ExecutionLimitService;
  groupRouting?: GroupRoutingService;
  oidc?: OidcService;
  auth?: AuthService;
  apiTokens?: ApiTokenService;
  providers?: ProviderConnections;
  invitations?: InvitationService;
  authenticationAttempts?: AuthenticationAttemptLimiter;
  logger?: boolean;
  readiness: ReadinessProbe;
  setupTokenDigest?: string;
  webOrigin?: string;
  workspaces?: WorkspaceService;
  members?: WorkspaceMemberService;
  groups?: GroupService;
  groupBots?: GroupBotService;
  bots?: BotService;
  botAcl?: BotAclService;
  botLifecycle?: BotLifecycleService;
  avatars?: BotAvatarService;
  attachments?: AttachmentService;
  knowledge?: KnowledgeService;
  conversations?: ConversationService;
  botVersions?: BotVersionService;
  botCopies?: BotCopyService;
  botTemplates?: BotTemplateService;
}

const SESSION_COOKIE = 'openbot_session';
const AUTHENTICATION_API_PATHS = new Set([
  '/api/v1/auth/state',
  '/api/v1/me',
  '/api/v1/session',
  '/api/v1/setup',
]);

function serializeExpiredSessionCookie(secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

function hasValidSetupToken(
  value: string | string[] | undefined,
  expectedDigest: string | undefined,
) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedDigest ?? '')) {
    return false;
  }

  const actual = createHash('sha256').update(value).digest();
  const expected = Buffer.from(expectedDigest ?? '', 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readStringProperty(body: unknown, property: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[property];
  return typeof value === 'string' ? value : undefined;
}

function readSetupInput(body: unknown): SetupInput | undefined {
  const displayName = readStringProperty(body, 'displayName');
  const email = readStringProperty(body, 'email');
  const password = readStringProperty(body, 'password');
  return displayName === undefined || email === undefined || password === undefined
    ? undefined
    : { displayName, email, password };
}

function readSignInInput(body: unknown): SignInInput | undefined {
  const email = readStringProperty(body, 'email');
  const password = readStringProperty(body, 'password');
  return email === undefined || password === undefined ? undefined : { email, password };
}

function sendAuthenticatedSession(
  reply: FastifyReply,
  session: AuthenticatedSession,
  secure: boolean,
  statusCode: 200 | 201,
) {
  reply.header(
    'set-cookie',
    serializeSessionCookie(session.sessionToken, session.expiresAt, secure),
  );
  return reply.code(statusCode).send({ user: session.user, workspace: session.workspace });
}

export function buildApp({
  memories,
  oidc,
  auth,
  apiTokens,
  providers,
  invitations,
  authenticationAttempts = new AuthenticationAttemptLimiter(),
  logger = false,
  readiness,
  setupTokenDigest,
  webOrigin = 'http://localhost:3000',
  workspaces,
  members,
  groups,
  groupBots,
  bots,
  botAcl,
  botLifecycle,
  avatars,
  attachments,
  knowledge,
  conversations,
  conversationStreams,
  botVersions,
  botCopies,
  botTemplates,
  tasks,
  executionLimits,
  groupRouting,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger:
      logger === false
        ? false
        : {
            serializers: {
              req: (request: FastifyRequest) => ({
                method: request.method,
                url: String(request.url).split('?', 1)[0] ?? '/',
                hostname: request.hostname,
                remoteAddress: request.ip,
              }),
            },
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.headers["x-openbot-setup-token"]',
              'res.headers["set-cookie"]',
            ],
          },
    trustProxy: false,
  });

  registerOidcRoutes(app, oidc, webOrigin);
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found' } }),
  );

  app.get('/api/v1/status', async (_request, reply) => {
    const checks = await readiness.check();
    const ready = checks.database === 'ready' && checks.migrations === 'current';

    return reply.code(ready ? 200 : 503).send({
      schemaVersion: 1,
      status: ready ? 'ready' : 'unavailable',
      checks,
    });
  });

  if (apiTokens) registerPublicIdentityRoute(app, apiTokens);
  if (apiTokens && bots && botVersions && botLifecycle)
    registerPublicBotRoutes(app, apiTokens, bots, botVersions, botLifecycle);
  if (auth) {
    if (memories) registerMemoryRoutes(app, auth, memories, webOrigin);
    if (botCopies) registerBotCopyRoutes(app, auth, botCopies, webOrigin);
    if (botTemplates) registerBotTemplateRoutes(app, auth, botTemplates, webOrigin);
    if (tasks) registerTaskRoutes(app, auth, tasks, webOrigin);
    if (executionLimits) registerExecutionLimitRoutes(app, auth, executionLimits, webOrigin);
    if (groupRouting) registerGroupRoutingRoutes(app, auth, groupRouting, webOrigin);
    if (botVersions) registerBotVersionRoutes(app, auth, botVersions, webOrigin);
    if (groupBots) registerGroupBotRoutes(app, auth, groupBots, webOrigin);
    if (avatars) registerBotAvatarRoutes(app, auth, avatars, webOrigin);
    if (attachments) registerAttachmentRoutes(app, auth, attachments, webOrigin);
    if (knowledge) registerKnowledgeRoutes(app, auth, knowledge, webOrigin);
    if (conversations) registerConversationRoutes(app, auth, conversations, webOrigin);
    if (conversationStreams) registerConversationStreamRoutes(app, conversationStreams);
    if (bots) registerBotRoutes(app, auth, bots, webOrigin);
    if (botAcl) registerBotAclRoutes(app, auth, botAcl, webOrigin);
    if (botLifecycle) registerBotLifecycleRoutes(app, auth, botLifecycle, webOrigin);
    if (groups) registerGroupRoutes(app, auth, groups, webOrigin);
    if (apiTokens) registerApiTokenRoutes(app, auth, apiTokens, webOrigin);
    if (members) registerWorkspaceMemberRoutes(app, auth, members, webOrigin);
    registerProviderRoutes(app, auth, providers, webOrigin);
    if (invitations) registerInvitationRoutes(app, auth, invitations, webOrigin);
    if (workspaces) registerWorkspaceRoutes(app, auth, workspaces, webOrigin);
    const secureSessionCookie = new URL(webOrigin).protocol === 'https:';
    const hasTrustedOrigin = (origin: string | undefined): boolean => origin === webOrigin;

    app.addHook('onSend', async (request, reply, payload) => {
      const path = request.url.split('?', 1)[0];
      if (path && AUTHENTICATION_API_PATHS.has(path)) {
        reply.header('cache-control', 'private, no-store');
      }
      return payload;
    });

    app.get('/api/v1/auth/state', async (_request, reply) =>
      reply.code(200).send({ claimed: await auth.isClaimed() }),
    );

    app.post('/api/v1/setup', async (request, reply) => {
      if (!hasTrustedOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      }
      if (!hasValidSetupToken(request.headers['x-openbot-setup-token'], setupTokenDigest)) {
        return reply.code(403).send({ error: { code: 'invalid_setup_token' } });
      }

      const input = readSetupInput(request.body);
      if (!input) {
        return reply.code(400).send({ error: { code: 'invalid_request' } });
      }

      let session;
      try {
        session = await auth.setup(input);
      } catch (error) {
        if (error instanceof InstanceAlreadyClaimedError) {
          return reply.code(409).send({ error: { code: 'instance_already_claimed' } });
        }
        if (error instanceof InvalidAuthInputError) {
          return reply.code(400).send({ error: { code: 'invalid_request' } });
        }
        if (error instanceof AuthenticationBusyError) {
          reply.header('retry-after', '1');
          return reply.code(429).send({ error: { code: 'authentication_busy' } });
        }
        throw error;
      }
      return sendAuthenticatedSession(reply, session, secureSessionCookie, 201);
    });

    app.post('/api/v1/session', async (request, reply) => {
      if (!hasTrustedOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      }

      const input = readSignInInput(request.body);
      if (!input) {
        return reply.code(400).send({ error: { code: 'invalid_request' } });
      }

      const attempt = { clientIp: request.ip, email: input.email };
      const retryAfterSeconds = authenticationAttempts.retryAfterSeconds(attempt);
      if (retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(retryAfterSeconds));
        return reply.code(429).send({ error: { code: 'authentication_rate_limited' } });
      }

      try {
        const session = await auth.signIn(input);
        authenticationAttempts.clearAccount(input.email);
        return sendAuthenticatedSession(reply, session, secureSessionCookie, 200);
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          authenticationAttempts.recordFailure(attempt);
          return reply.code(401).send({ error: { code: 'invalid_credentials' } });
        }
        if (error instanceof AuthenticationBusyError) {
          reply.header('retry-after', '1');
          return reply.code(429).send({ error: { code: 'authentication_busy' } });
        }
        throw error;
      }
    });

    app.get('/api/v1/me', async (request, reply) => {
      const token = readSessionToken(request.headers.cookie);
      const session = token ? await auth.getSession(token) : undefined;
      if (!session) {
        return reply.code(401).send({ error: { code: 'authentication_required' } });
      }

      return reply.code(200).send(session);
    });

    app.delete('/api/v1/session', async (request, reply) => {
      if (!hasTrustedOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      }

      const token = readSessionToken(request.headers.cookie);
      const revoked = token ? await auth.signOut(token) : false;
      if (!revoked) {
        return reply.code(401).send({ error: { code: 'authentication_required' } });
      }

      reply.header('set-cookie', serializeExpiredSessionCookie(secureSessionCookie));
      return reply.code(204).send();
    });
  }

  return app;
}

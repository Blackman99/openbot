import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { AuthenticationAttemptLimiter } from './auth/attempt-limiter.js';
import { InstanceAlreadyClaimedError } from './auth/repository.js';
import { readSessionToken } from './auth/session-cookie.js';
import {
  AuthenticationBusyError,
  InvalidAuthInputError,
  InvalidCredentialsError,
  type AuthenticatedSession,
  type AuthService,
  type SetupInput,
  type SignInInput,
} from './auth/service.js';
import type { ReadinessProbe } from './readiness.js';
import { registerWorkspaceRoutes } from './workspaces/routes.js';
import type { WorkspaceService } from './workspaces/service.js';

export interface BuildAppOptions {
  auth?: AuthService;
  authenticationAttempts?: AuthenticationAttemptLimiter;
  logger?: boolean;
  readiness: ReadinessProbe;
  setupTokenDigest?: string;
  webOrigin?: string;
  workspaces?: WorkspaceService;
}

const SESSION_COOKIE = 'openbot_session';
const AUTHENTICATION_API_PATHS = new Set([
  '/api/v1/auth/state',
  '/api/v1/me',
  '/api/v1/session',
  '/api/v1/setup',
]);

function serializeSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

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
  auth,
  authenticationAttempts = new AuthenticationAttemptLimiter(),
  logger = false,
  readiness,
  setupTokenDigest,
  webOrigin = 'http://localhost:3000',
  workspaces,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger:
      logger === false
        ? false
        : {
            redact: [
              'req.headers.cookie',
              'req.headers["x-openbot-setup-token"]',
              'res.headers["set-cookie"]',
            ],
          },
    trustProxy: false,
  });

  app.get('/api/v1/status', async (_request, reply) => {
    const checks = await readiness.check();
    const ready = checks.database === 'ready' && checks.migrations === 'current';

    return reply.code(ready ? 200 : 503).send({
      schemaVersion: 1,
      status: ready ? 'ready' : 'unavailable',
      checks,
    });
  });

  if (auth) {
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

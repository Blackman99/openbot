import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { BotAccessError, BotInputError, BotModelError } from './service.js';
import {
  BotLifecycleConflictError,
  BotRecoveryExpiredError,
  type BotLifecycleService,
} from './lifecycle-service.js';

export function registerBotLifecycleRoutes(
  app: FastifyInstance,
  auth: AuthService,
  lifecycle: BotLifecycleService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof BotAccessError)
        return reply.code(403).send({ error: { code: 'bot_forbidden' } });
      if (error instanceof BotRecoveryExpiredError)
        return reply.code(409).send({ error: { code: 'bot_recovery_expired' } });
      if (error instanceof BotLifecycleConflictError)
        return reply.code(409).send({ error: { code: 'bot_lifecycle_conflict' } });
      if (error instanceof BotModelError)
        return reply
          .code(400)
          .send({ error: { code: 'bot_model_unavailable', reason: error.reason } });
      if (error instanceof BotInputError)
        return reply.code(400).send({ error: { code: 'invalid_bot_request' } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_bot_request' } });
      return reply.code(503).send({ error: { code: 'bot_unavailable' } });
    });
    for (const [action, method] of [
      ['archive', 'archive'],
      ['restore', 'restore'],
      ['delete', 'softDelete'],
      ['undo-delete', 'undoDelete'],
    ] as const)
      routes.post<{ Params: { workspaceId: string; botId: string } }>(
        `/api/v1/workspaces/:workspaceId/bots/:botId/${action}`,
        { bodyLimit: 1024 },
        async (request, reply) => {
          if (request.headers.origin !== webOrigin)
            return reply.code(403).send({ error: { code: 'invalid_origin' } });
          const token = readSessionToken(request.headers.cookie);
          const identity = token ? await auth.getSession(token) : undefined;
          if (!identity)
            return reply.code(401).send({ error: { code: 'authentication_required' } });
          if (request.body !== undefined) throw new BotInputError();
          return {
            lifecycle: await lifecycle[method](
              identity.user.id,
              request.params.workspaceId,
              request.params.botId,
            ),
          };
        },
      );
    routes.get<{ Params: { workspaceId: string; botId: string } }>(
      '/api/v1/workspaces/:workspaceId/bots/:botId/lifecycle',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          lifecycle: await lifecycle.get(
            identity.user.id,
            request.params.workspaceId,
            request.params.botId,
          ),
        };
      },
    );
  });
}

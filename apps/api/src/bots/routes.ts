import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { BotAccessError, BotInputError, BotModelError, type BotService } from './service.js';
export function registerBotRoutes(
  app: FastifyInstance,
  auth: AuthService,
  bots: BotService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof BotModelError)
        return reply
          .code(400)
          .send({ error: { code: 'bot_model_unavailable', reason: error.reason } });
      if (error instanceof BotInputError)
        return reply.code(400).send({ error: { code: 'invalid_bot_request' } });
      if (error instanceof BotAccessError)
        return reply.code(403).send({ error: { code: 'bot_forbidden' } });
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
    routes.get<{ Params: { workspaceId: string }; Querystring: { view?: string } }>(
      '/api/v1/workspaces/:workspaceId/bots',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          bots: await bots.list(identity.user.id, request.params.workspaceId, request.query.view),
        };
      },
    );
    routes.get<{ Params: { workspaceId: string; botId: string } }>(
      '/api/v1/workspaces/:workspaceId/bots/:botId',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          bot: await bots.get(identity.user.id, request.params.workspaceId, request.params.botId),
        };
      },
    );
    routes.post<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/bots',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return reply.code(201).send({
          bot: await bots.create(identity.user.id, request.params.workspaceId, request.body),
        });
      },
    );
  });
}

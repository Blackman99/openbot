import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { GroupAccessError } from '../groups/service.js';
import { GroupBotAccessError, GroupBotInputError } from '../group-bots/service.js';
import { BotModelError } from '../bots/service.js';
import {
  GroupRoutingService,
  RoutingSettingConflictError,
  RoutingSettingInputError,
} from './service.js';

export function registerGroupRoutingRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: GroupRoutingService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof GroupAccessError || error instanceof GroupBotAccessError)
        return reply.code(403).send({ error: { code: 'routing_forbidden' } });
      if (error instanceof RoutingSettingConflictError)
        return reply.code(409).send({ error: { code: 'routing_revision_conflict' } });
      if (error instanceof BotModelError)
        return reply.code(409).send({ error: { code: 'routing_model_unavailable' } });
      if (error instanceof RoutingSettingInputError || error instanceof GroupBotInputError)
        return reply.code(400).send({ error: { code: 'invalid_routing_request' } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_routing_request' } });
      return reply.code(503).send({ error: { code: 'routing_unavailable' } });
    });
    type Params = { workspaceId: string; groupId: string };
    const path = '/api/v1/workspaces/:workspaceId/groups/:groupId/routing';
    routes.get<{ Params: Params }>(path, async (request, reply) => {
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      if (Object.keys(request.query as object).length) throw new RoutingSettingInputError();
      return {
        routing: await service.get(
          identity.user.id,
          request.params.workspaceId,
          request.params.groupId,
        ),
      };
    });
    routes.patch<{ Params: Params }>(path, { bodyLimit: 4096 }, async (request, reply) => {
      if (request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      if (Object.keys(request.query as object).length) throw new RoutingSettingInputError();
      return {
        routing: await service.update(
          identity.user.id,
          request.params.workspaceId,
          request.params.groupId,
          request.body,
        ),
      };
    });
  });
}

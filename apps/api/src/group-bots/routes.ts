import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { GroupArchivedError } from '../groups/service.js';
import {
  GroupBotAccessError,
  GroupBotConflictError,
  GroupBotInputError,
  type GroupBotService,
} from './service.js';
export function registerGroupBotRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: GroupBotService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof GroupArchivedError)
        return reply.code(409).send({ error: { code: 'group_archived' } });
      if (error instanceof GroupBotAccessError)
        return reply.code(403).send({ error: { code: 'group_bot_forbidden' } });
      if (error instanceof GroupBotConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof GroupBotInputError)
        return reply.code(400).send({ error: { code: 'invalid_group_bot_request' } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_group_bot_request' } });
      return reply.code(503).send({ error: { code: 'group_bot_unavailable' } });
    });
    type Params = { workspaceId: string; groupId: string };
    const path = '/api/v1/workspaces/:workspaceId/groups/:groupId/bots';
    routes.post<{ Params: Params & { grantId: string } }>(
      `${path}/:grantId/remove`,
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          grant: await service.remove(
            identity.user.id,
            request.params.workspaceId,
            request.params.groupId,
            request.params.grantId,
            request.body,
          ),
        };
      },
    );
    routes.get<{ Params: Params & { grantId: string } }>(
      `${path}/:grantId/context`,
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return service.context(
          identity.user.id,
          request.params.workspaceId,
          request.params.groupId,
          request.params.grantId,
          request.query,
        );
      },
    );
    routes.get<{ Params: Params }>(path, async (request, reply) => {
      const token = readSessionToken(request.headers.cookie),
        identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return service.list(identity.user.id, request.params.workspaceId, request.params.groupId);
    });
    routes.post<{ Params: Params }>(path, async (request, reply) => {
      if (request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie),
        identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return {
        grant: await service.invite(
          identity.user.id,
          request.params.workspaceId,
          request.params.groupId,
          request.body,
        ),
      };
    });
  });
}

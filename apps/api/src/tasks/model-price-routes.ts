import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readSessionToken } from '../auth/session-cookie.js';
import type { AuthService } from '../auth/service.js';
import { ModelPriceService, TaskAccessError, TaskInputError } from './model-price-service.js';

export function registerModelPriceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  prices: ModelPriceService,
  webOrigin: string,
): void {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof TaskInputError)
        return reply.code(400).send({ error: { code: 'invalid_model_price' } });
      if (error instanceof TaskAccessError)
        return reply.code(403).send({ error: { code: 'workspace_forbidden' } });
      return reply.send(error);
    });
    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        request.headers.origin !== webOrigin
      ) {
        reply.code(403).send({ error: { code: 'invalid_origin' } });
        return undefined;
      }
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (!identity) reply.code(401).send({ error: { code: 'authentication_required' } });
      return identity;
    }
    routes.get<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/model-prices',
      async (request, reply) => {
        const identity = await authenticate(request, reply);
        if (!identity) return reply;
        return { prices: await prices.list(identity.user.id, request.params.workspaceId) };
      },
    );
    routes.put<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/model-prices',
      async (request, reply) => {
        const identity = await authenticate(request, reply);
        if (!identity) return reply;
        return {
          price: await prices.supersede(identity.user.id, request.params.workspaceId, request.body),
        };
      },
    );
  });
}

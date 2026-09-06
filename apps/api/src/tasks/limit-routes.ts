import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { GroupAccessError } from '../groups/service.js';
import { TaskInputError } from './errors.js';
import { LimitAccessError, LimitConflictError, LimitInputError } from './execution-limits.js';
import { ExecutionLimitService } from './limit-policy.js';

export function registerExecutionLimitRoutes(
  app: FastifyInstance,
  auth: AuthService,
  limits: ExecutionLimitService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof LimitAccessError || error instanceof GroupAccessError)
        return reply.code(403).send({ error: { code: 'execution_limit_forbidden' } });
      if (error instanceof LimitConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof LimitInputError || error instanceof TaskInputError)
        return reply.code(400).send({ error: { code: 'invalid_execution_limit' } });
      return reply.code(503).send({ error: { code: 'execution_limit_unavailable' } });
    });
    routes.put<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/execution-limits',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          policy: await limits.putWorkspacePolicy(
            identity.user.id,
            request.params.workspaceId,
            request.body,
          ),
        };
      },
    );
    routes.put<{ Params: { workspaceId: string; groupId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups/:groupId/execution-limits',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          policy: await limits.putGroupPolicy(
            identity.user.id,
            request.params.workspaceId,
            request.params.groupId,
            request.body,
          ),
        };
      },
    );
  });
}

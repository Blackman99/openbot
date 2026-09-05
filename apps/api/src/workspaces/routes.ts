import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { readSessionToken } from '../auth/session-cookie.js';
import type { AuthService } from '../auth/service.js';
import {
  InvalidWorkspaceInputError,
  WorkspaceAccessError,
  type WorkspaceService,
} from './service.js';

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  workspaces: WorkspaceService,
  webOrigin: string,
): void {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof InvalidWorkspaceInputError)
        return reply.code(400).send({ error: { code: 'invalid_workspace' } });
      if (error instanceof WorkspaceAccessError)
        return reply.code(404).send({ error: { code: 'workspace_not_found' } });
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
    routes.post('/api/v1/workspaces', async (request, reply) => {
      const identity = await authenticate(request, reply);
      if (!identity) return reply;
      return reply
        .code(201)
        .send({ workspace: await workspaces.create(identity.user.id, request.body) });
    });
    routes.get('/api/v1/workspaces', async (request, reply) => {
      const identity = await authenticate(request, reply);
      if (!identity) return reply;
      return { workspaces: await workspaces.list(identity.user.id) };
    });
    routes.get<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId',
      async (request, reply) => {
        const identity = await authenticate(request, reply);
        if (!identity) return reply;
        return { workspace: await workspaces.get(identity.user.id, request.params.workspaceId) };
      },
    );
    routes.patch<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId',
      async (request, reply) => {
        const identity = await authenticate(request, reply);
        if (!identity) return reply;
        return {
          workspace: await workspaces.update(
            identity.user.id,
            request.params.workspaceId,
            request.body,
          ),
        };
      },
    );
  });
}

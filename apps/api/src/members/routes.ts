import type { FastifyInstance } from 'fastify';
import { readSessionToken } from '../auth/session-cookie.js';
import type { AuthService } from '../auth/service.js';
import {
  WorkspaceMemberAccessError,
  LastWorkspaceOwnerError,
  WorkspaceMemberNotFoundError,
  WorkspaceMemberInputError,
  type WorkspaceMemberService,
} from './service.js';

export function registerWorkspaceMemberRoutes(
  app: FastifyInstance,
  auth: AuthService,
  members: WorkspaceMemberService,
  webOrigin: string,
): void {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof LastWorkspaceOwnerError)
        return reply.code(409).send({ error: { code: 'last_owner_required' } });
      if (error instanceof WorkspaceMemberAccessError)
        return reply.code(403).send({ error: { code: 'workspace_forbidden' } });
      if (error instanceof WorkspaceMemberNotFoundError)
        return reply.code(404).send({ error: { code: 'member_not_found' } });
      if (error instanceof WorkspaceMemberInputError)
        return reply.code(400).send({ error: { code: 'invalid_member_request' } });
      return reply.send(error);
    });
    routes.delete<{ Params: { workspaceId: string; userId: string } }>(
      '/api/v1/workspaces/:workspaceId/members/:userId',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        await members.remove(identity.user.id, request.params.workspaceId, request.params.userId);
        return reply.code(204).send();
      },
    );
    routes.patch<{ Params: { workspaceId: string; userId: string } }>(
      '/api/v1/workspaces/:workspaceId/members/:userId',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          member: await members.changeRole(
            identity.user.id,
            request.params.workspaceId,
            request.params.userId,
            request.body,
          ),
        };
      },
    );
    routes.get<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/members',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return { members: await members.list(identity.user.id, request.params.workspaceId) };
      },
    );
  });
}

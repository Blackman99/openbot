import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import {
  GroupAccessError,
  GroupArchivedError,
  GroupInputError,
  GroupMemberNotFoundError,
  GroupMemberConflictError,
  LastGroupOwnerError,
  type GroupService,
} from './service.js';

export function registerGroupRoutes(
  app: FastifyInstance,
  auth: AuthService,
  groups: GroupService,
  webOrigin: string,
): void {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof GroupArchivedError)
        return reply.code(409).send({ error: { code: 'group_archived' } });
      if (error instanceof LastGroupOwnerError)
        return reply.code(409).send({ error: { code: 'last_group_owner_required' } });
      if (error instanceof GroupMemberNotFoundError)
        return reply.code(404).send({ error: { code: 'group_member_not_found' } });
      if (error instanceof GroupMemberConflictError)
        return reply.code(409).send({ error: { code: 'group_member_conflict' } });
      if (error instanceof GroupAccessError)
        return reply.code(403).send({ error: { code: 'group_forbidden' } });
      if (error instanceof GroupInputError)
        return reply.code(400).send({ error: { code: 'invalid_group_request' } });
      return reply.send(error);
    });
    routes.get<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return { groups: await groups.list(identity.user.id, request.params.workspaceId) };
      },
    );
    routes.get<{ Params: { workspaceId: string; groupId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups/:groupId',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          group: await groups.get(
            identity.user.id,
            request.params.workspaceId,
            request.params.groupId,
          ),
        };
      },
    );
    routes.get<{ Params: { workspaceId: string; groupId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups/:groupId/members',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          members: await groups.members(
            identity.user.id,
            request.params.workspaceId,
            request.params.groupId,
          ),
        };
      },
    );
    routes.post<{ Params: { workspaceId: string; groupId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups/:groupId/members',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return reply.code(201).send({
          member: await groups.addMember(
            identity.user.id,
            request.params.workspaceId,
            request.params.groupId,
            request.body,
          ),
        });
      },
    );
    routes.patch<{ Params: { workspaceId: string; groupId: string; userId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups/:groupId/members/:userId',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          member: await groups.changeRole(
            identity.user.id,
            request.params.workspaceId,
            request.params.groupId,
            request.params.userId,
            request.body,
          ),
        };
      },
    );
    routes.delete<{ Params: { workspaceId: string; groupId: string; userId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups/:groupId/members/:userId',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        await groups.removeMember(
          identity.user.id,
          request.params.workspaceId,
          request.params.groupId,
          request.params.userId,
        );
        return reply.code(204).send();
      },
    );
    routes.patch<{ Params: { workspaceId: string; groupId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups/:groupId',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          group: await groups.update(
            identity.user.id,
            request.params.workspaceId,
            request.params.groupId,
            request.body,
          ),
        };
      },
    );
    routes.post<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return reply.code(201).send({
          group: await groups.create(identity.user.id, request.params.workspaceId, request.body),
        });
      },
    );
  });
}

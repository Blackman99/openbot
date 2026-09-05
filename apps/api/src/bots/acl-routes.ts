import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { BotAccessError, BotInputError } from './service.js';
import {
  BotAclConflictError,
  BotAclMemberNotFoundError,
  LastBotOwnerError,
  type BotAclService,
} from './acl-service.js';
export function registerBotAclRoutes(
  app: FastifyInstance,
  auth: AuthService,
  acl: BotAclService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof BotInputError)
        return reply.code(400).send({ error: { code: 'invalid_bot_request' } });
      if (error instanceof BotAccessError)
        return reply.code(403).send({ error: { code: 'bot_forbidden' } });
      if (error instanceof BotAclConflictError)
        return reply.code(409).send({ error: { code: 'bot_acl_conflict' } });
      if (error instanceof LastBotOwnerError)
        return reply.code(409).send({ error: { code: 'last_bot_owner_required' } });
      if (error instanceof BotAclMemberNotFoundError)
        return reply.code(404).send({ error: { code: 'bot_acl_member_not_found' } });
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
    type Params = { workspaceId: string; botId: string };
    const path = '/api/v1/workspaces/:workspaceId/bots/:botId/acl';
    routes.get<{ Params: Params }>(path, async (request, reply) => {
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return {
        members: await acl.list(identity.user.id, request.params.workspaceId, request.params.botId),
      };
    });
    routes.post<{ Params: Params }>(path, async (request, reply) => {
      if (request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return reply.code(201).send({
        member: await acl.grant(
          identity.user.id,
          request.params.workspaceId,
          request.params.botId,
          request.body,
        ),
      });
    });
    routes.patch<{ Params: Params & { userId: string } }>(
      `${path}/:userId`,
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          member: await acl.changeRole(
            identity.user.id,
            request.params.workspaceId,
            request.params.botId,
            request.params.userId,
            request.body,
          ),
        };
      },
    );
    routes.delete<{ Params: Params & { userId: string } }>(
      `${path}/:userId`,
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        if (request.body !== undefined) throw new BotInputError();
        await acl.revoke(
          identity.user.id,
          request.params.workspaceId,
          request.params.botId,
          request.params.userId,
        );
        return reply.code(204).send();
      },
    );
    routes.patch<{ Params: Params }>(
      '/api/v1/workspaces/:workspaceId/bots/:botId/visibility',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return acl.changeVisibility(
          identity.user.id,
          request.params.workspaceId,
          request.params.botId,
          request.body,
        );
      },
    );
  });
}

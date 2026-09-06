import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import {
  ConversationAccessError,
  ConversationConflictError,
  InvalidConversationInputError,
  type ConversationService,
} from './service.js';

export function registerConversationRoutes(
  app: FastifyInstance,
  auth: AuthService,
  conversations: ConversationService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ConversationAccessError)
        return reply.code(403).send({ error: { code: 'conversation_forbidden' } });
      if (error instanceof ConversationConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof InvalidConversationInputError)
        return reply.code(400).send({ error: { code: 'invalid_conversation_request' } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        return reply
          .code(error.statusCode)
          .send({ error: { code: 'invalid_conversation_request' } });
      return reply.code(503).send({ error: { code: 'conversation_unavailable' } });
    });
    routes.post<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          conversation: await conversations.open(
            identity.user.id,
            request.params.workspaceId,
            request.body,
          ),
        };
      },
    );
    routes.get<{ Params: { workspaceId: string; conversationId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return conversations.get(
          identity.user.id,
          request.params.workspaceId,
          request.params.conversationId,
          request.query,
        );
      },
    );
    routes.post<{ Params: { workspaceId: string; conversationId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/messages',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          receipt: await conversations.append(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
            request.body,
          ),
        };
      },
    );
    routes.patch<{ Params: { workspaceId: string; conversationId: string; messageId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          receipt: await conversations.edit(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
            request.params.messageId,
            request.body,
          ),
        };
      },
    );
    routes.get<{ Params: { workspaceId: string; conversationId: string; messageId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/versions',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          versions: await conversations.versions(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
            request.params.messageId,
          ),
        };
      },
    );
    routes.post<{ Params: { workspaceId: string; conversationId: string; messageId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/tombstone',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          receipt: await conversations.tombstone(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
            request.params.messageId,
            request.body,
          ),
        };
      },
    );
  });
}

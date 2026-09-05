import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { ConversationAccessError } from '../conversations/service.js';
import { AttachmentInputError, AttachmentUnavailableError } from '../attachments/types.js';
import {
  KnowledgeAccessError,
  KnowledgeConflictError,
  KnowledgeInputError,
  knowledgeAccess,
} from './types.js';
import type { KnowledgeService } from './service.js';

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  auth: AuthService,
  knowledge: KnowledgeService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ConversationAccessError || error instanceof KnowledgeAccessError)
        return reply.code(403).send({ error: { code: 'knowledge_forbidden' } });
      if (error instanceof KnowledgeConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof KnowledgeInputError || error instanceof AttachmentInputError)
        return reply.code(400).send({ error: { code: 'invalid_knowledge_request' } });
      if (error instanceof AttachmentUnavailableError)
        return reply.code(503).send({ error: { code: 'knowledge_unavailable' } });
      return reply.code(503).send({ error: { code: 'knowledge_unavailable' } });
    });
    type Params = { workspaceId: string; conversationId: string; messageId: string };
    routes.addHook('onRequest', async (request, reply) => {
      if (request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie);
      if (!token || !(await auth.getSession(token)))
        return reply.code(401).send({ error: { code: 'authentication_required' } });
    });
    routes.post<{ Params: Params }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/knowledge/preview',
      async (request) => {
        const identity = await auth.getSession(readSessionToken(request.headers.cookie)!);
        if (!identity) throw new KnowledgeInputError();
        if (
          !request.body ||
          typeof request.body !== 'object' ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length
        )
          throw new KnowledgeInputError();
        return knowledge.preview(
          knowledgeAccess(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
          ),
          request.params.messageId,
        );
      },
    );
    routes.post<{ Params: Params }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/knowledge/promotions',
      async (request, reply) => {
        const identity = await auth.getSession(readSessionToken(request.headers.cookie)!);
        if (!identity) throw new KnowledgeInputError();
        const result = await knowledge.promote(
          knowledgeAccess(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
          ),
          request.params.messageId,
          request.body,
        );
        return reply.code(result.created ? 201 : 200).send({ document: result.document });
      },
    );
  });
}

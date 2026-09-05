import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import {
  ConversationAccessError,
  ConversationConflictError,
  InvalidConversationInputError,
} from '../conversations/service.js';
import { AttachmentInputError, attachmentAccess, attachmentDisposition } from './types.js';
import type { AttachmentService } from './service.js';
export function registerAttachmentRoutes(
  app: FastifyInstance,
  auth: AuthService,
  attachments: AttachmentService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: attachments.maximumBytes + 131076 },
      (_request, body, done) => done(null, body),
    );
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ConversationAccessError)
        return reply.code(403).send({ error: { code: 'conversation_forbidden' } });
      if (error instanceof ConversationConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof AttachmentInputError || error instanceof InvalidConversationInputError)
        return reply.code(400).send({ error: { code: 'invalid_attachment' } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        [400, 413, 415].includes(Number(error.statusCode))
      )
        return reply.code(Number(error.statusCode)).send({ error: { code: 'invalid_attachment' } });
      return reply.code(503).send({ error: { code: 'attachment_unavailable' } });
    });
    type Params = { workspaceId: string; conversationId: string; messageId: string };
    routes.addHook('onRequest', async (request, reply) => {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie),
        identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      const params = request.params as Params;
      if (request.method === 'POST')
        await attachments.authorize(
          attachmentAccess(identity.user.id, params.workspaceId, params.conversationId),
        );
    });
    const base = '/api/v1/workspaces/:workspaceId/conversations/:conversationId';
    routes.post<{ Params: Params }>(
      base + '/attachments',
      { bodyLimit: attachments.maximumBytes + 131076 },
      async (request, reply) => {
        const identity = await auth.getSession(readSessionToken(request.headers.cookie)!);
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        if (!Buffer.isBuffer(request.body) || request.body.length < 5)
          throw new AttachmentInputError();
        const metadataBytes = request.body.readUInt32BE(0);
        if (!metadataBytes || metadataBytes > 131072 || metadataBytes + 4 >= request.body.length)
          throw new AttachmentInputError();
        let command: unknown;
        try {
          command = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              request.body.subarray(4, 4 + metadataBytes),
            ),
          );
        } catch {
          throw new AttachmentInputError();
        }
        const content = request.body.subarray(4 + metadataBytes);
        const controller = new AbortController();
        const abort = () => controller.abort();
        const closed = () => {
          if (!reply.raw.writableEnded) abort();
        };
        request.raw.once('aborted', abort);
        reply.raw.once('close', closed);
        const timer = setTimeout(abort, 30000);
        timer.unref();
        if (request.raw.aborted) abort();
        try {
          return {
            receipt: await attachments.upload(
              attachmentAccess(
                identity.user.id,
                request.params.workspaceId,
                request.params.conversationId,
              ),
              command,
              content,
              controller.signal,
            ),
          };
        } finally {
          clearTimeout(timer);
          request.raw.off('aborted', abort);
          reply.raw.off('close', closed);
        }
      },
    );
    routes.post<{ Params: Params }>(base + '/messages/:messageId/purge', async (request, reply) => {
      const identity = await auth.getSession(readSessionToken(request.headers.cookie)!);
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      if (
        !request.body ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length
      )
        throw new AttachmentInputError();
      const purge = await attachments.purge(
        attachmentAccess(
          identity.user.id,
          request.params.workspaceId,
          request.params.conversationId,
        ),
        request.params.messageId,
      );
      return reply.code(purge.state === 'complete' ? 200 : 202).send({ purge });
    });
    for (const content of [false, true])
      routes.get<{ Params: Params }>(
        base + '/messages/:messageId/attachment' + (content ? '/content' : ''),
        async (request, reply) => {
          const identity = await auth.getSession(readSessionToken(request.headers.cookie)!);
          if (!identity)
            return reply.code(401).send({ error: { code: 'authentication_required' } });
          const access = attachmentAccess(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
          );
          if (!content)
            return { attachment: await attachments.metadata(access, request.params.messageId) };
          const result = await attachments.read(
            access,
            request.params.messageId,
            AbortSignal.timeout(30000),
          );
          return reply
            .type(result.metadata.mediaType)
            .header('content-disposition', attachmentDisposition(result.metadata.filename))
            .send(result.bytes);
        },
      );
  });
}

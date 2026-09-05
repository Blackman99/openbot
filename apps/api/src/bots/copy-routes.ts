import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { BotAccessError, BotInputError, BotModelError } from './service.js';
import { BotVersionConflictError, BotAvatarUnavailableError } from './append-version.js';
import type { BotCopyService } from './copy-service.js';
export function registerBotCopyRoutes(
  app: FastifyInstance,
  auth: AuthService,
  copies: BotCopyService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return payload;
    });
    routes.addHook('onRequest', async (request, reply) => {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie);
      if (!token || !(await auth.getSession(token)))
        return reply.code(401).send({ error: { code: 'authentication_required' } });
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof BotAccessError)
        return reply.code(403).send({ error: { code: 'bot_forbidden' } });
      if (error instanceof BotInputError)
        return reply.code(400).send({ error: { code: 'invalid_bot_copy_request' } });
      if (error instanceof BotVersionConflictError)
        return reply.code(409).send({ error: { code: 'bot_version_conflict' } });
      if (error instanceof BotAvatarUnavailableError)
        return reply.code(409).send({ error: { code: 'bot_avatar_unavailable' } });
      if (error instanceof BotModelError)
        return reply
          .code(400)
          .send({ error: { code: 'bot_model_unavailable', reason: error.reason } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        [400, 413, 415].includes(Number(error.statusCode))
      )
        return reply
          .code(Number(error.statusCode))
          .send({ error: { code: 'invalid_bot_copy_request' } });
      return reply.code(503).send({ error: { code: 'bot_copy_unavailable' } });
    });
    type Params = { workspaceId: string; botId: string };
    const scope = async (cookie: string | undefined, params: Params) => {
      const identity = await auth.getSession(readSessionToken(cookie)!);
      return identity
        ? copies.access(identity.user.id, params.workspaceId, params.botId)
        : undefined;
    };
    const base = '/api/v1/workspaces/:workspaceId/bots/:botId';
    routes.get<{ Params: Params }>(`${base}/copy-preview`, async (request, reply) => {
      const access = await scope(request.headers.cookie, request.params);
      if (!access) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return { preview: await copies.preview(access) };
    });
    routes.post<{ Params: Params }>(`${base}/copy`, { bodyLimit: 4096 }, async (request, reply) => {
      const access = await scope(request.headers.cookie, request.params);
      if (!access) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return reply.code(201).send({ bot: await copies.confirm(access, request.body) });
    });
  });
}

import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { BotAccessError, BotInputError, BotModelError } from './service.js';
import { BotVersionConflictError, BotAvatarUnavailableError } from './append-version.js';
import { BotVersionNotFoundError } from './version-data.js';
import type { BotVersionService } from './version-service.js';
export function registerBotVersionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  versions: BotVersionService,
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
        return reply.code(400).send({ error: { code: 'invalid_bot_version_request' } });
      if (error instanceof BotVersionConflictError)
        return reply.code(409).send({ error: { code: 'bot_version_conflict' } });
      if (error instanceof BotAvatarUnavailableError)
        return reply.code(409).send({ error: { code: 'bot_avatar_unavailable' } });
      if (error instanceof BotVersionNotFoundError)
        return reply.code(404).send({ error: { code: 'bot_version_not_found' } });
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
          .send({ error: { code: 'invalid_bot_version_request' } });
      return reply.code(503).send({ error: { code: 'bot_version_unavailable' } });
    });
    type Params = { workspaceId: string; botId: string; versionId?: string };
    const scope = async (cookie: string | undefined, params: Params) => {
      const identity = await auth.getSession(readSessionToken(cookie)!);
      return identity
        ? versions.access(identity.user.id, params.workspaceId, params.botId)
        : undefined;
    };
    const base = '/api/v1/workspaces/:workspaceId/bots/:botId';
    routes.patch<{ Params: Params }>(
      `${base}/configuration`,
      { bodyLimit: 262144 },
      async (request, reply) => {
        const access = await scope(request.headers.cookie, request.params);
        if (!access) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return { version: await versions.edit(access, request.body) };
      },
    );
    routes.post<{ Params: Params }>(
      `${base}/versions/restore`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const access = await scope(request.headers.cookie, request.params);
        if (!access) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return { version: await versions.restore(access, request.body) };
      },
    );
    routes.get<{ Params: Params }>(`${base}/versions`, async (request, reply) => {
      const access = await scope(request.headers.cookie, request.params);
      if (!access) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return versions.list(access, request.query);
    });
    routes.get<{ Params: Params; Querystring: { fromVersionId?: string; toVersionId?: string } }>(
      `${base}/versions/compare`,
      async (request, reply) => {
        const access = await scope(request.headers.cookie, request.params);
        if (!access) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return versions.compare(access, request.query.fromVersionId, request.query.toVersionId);
      },
    );
    routes.get<{ Params: Params }>(`${base}/versions/:versionId`, async (request, reply) => {
      const access = await scope(request.headers.cookie, request.params);
      if (!access) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return { version: await versions.get(access, request.params.versionId) };
    });
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { ObjectNotFoundError } from '../objects/store.js';
import { avatarAccess, type BotAvatarService } from './avatar-service.js';
import { BotAccessError, BotInputError } from './service.js';
import { BotVersionConflictError } from './append-version.js';
import { AvatarImageError, AvatarBusyError } from './avatar-image.js';

async function withRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', closed);
  const timer = setTimeout(abort, 30_000);
  timer.unref();
  if (request.raw.aborted) abort();
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    request.raw.off('aborted', abort);
    reply.raw.off('close', closed);
  }
}

export function registerBotAvatarRoutes(
  app: FastifyInstance,
  auth: AuthService,
  avatars: BotAvatarService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addContentTypeParser(
      ['image/png', 'image/jpeg'],
      { parseAs: 'buffer', bodyLimit: 2097152 },
      (_request, body, done) => done(null, body),
    );
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof BotAccessError)
        return reply.code(403).send({ error: { code: 'bot_forbidden' } });
      if (error instanceof BotVersionConflictError)
        return reply.code(409).send({ error: { code: 'bot_version_conflict' } });
      if (error instanceof ObjectNotFoundError)
        return reply.code(404).send({ error: { code: 'avatar_not_found' } });
      if (error instanceof BotInputError || error instanceof AvatarImageError)
        return reply.code(400).send({ error: { code: 'invalid_avatar' } });
      if (error instanceof AvatarBusyError)
        return reply.code(429).send({ error: { code: 'avatar_busy' } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        [400, 413, 415].includes(Number(error.statusCode))
      )
        return reply.code(Number(error.statusCode)).send({ error: { code: 'invalid_avatar' } });
      return reply.code(503).send({ error: { code: 'avatar_unavailable' } });
    });
    type Params = { workspaceId: string; botId: string };
    type Query = { expectedCurrentVersionId?: string; versionId?: string };
    routes.addHook('onRequest', async (request, reply) => {
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        request.headers.origin !== webOrigin
      )
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      const params = request.params as Params;
      if (request.method !== 'GET' && request.method !== 'HEAD')
        await avatars.authorizeEdit(
          avatarAccess(identity.user.id, params.workspaceId, params.botId),
        );
    });
    const path = '/api/v1/workspaces/:workspaceId/bots/:botId/avatar';
    routes.get<{ Params: Params; Querystring: Query }>(path, async (request, reply) => {
      const identity = await auth.getSession(readSessionToken(request.headers.cookie)!);
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return reply
        .type('image/png')
        .send(
          await withRequestSignal(request, reply, (signal) =>
            avatars.read(
              avatarAccess(identity.user.id, request.params.workspaceId, request.params.botId),
              request.query.versionId,
              signal,
            ),
          ),
        );
    });
    routes.put<{ Params: Params; Querystring: Query }>(
      path,
      { bodyLimit: 2097152 },
      async (request, reply) => {
        const identity = await auth.getSession(readSessionToken(request.headers.cookie)!);
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        if (!Buffer.isBuffer(request.body)) throw new BotInputError();
        const bytes = request.body;
        return {
          version: await withRequestSignal(request, reply, (signal) =>
            avatars.upload(
              avatarAccess(identity.user.id, request.params.workspaceId, request.params.botId),
              request.query.expectedCurrentVersionId,
              bytes,
              request.headers['content-type'] ?? '',
              signal,
            ),
          ),
        };
      },
    );
    routes.delete<{ Params: Params; Querystring: Query }>(path, async (request, reply) => {
      const identity = await auth.getSession(readSessionToken(request.headers.cookie)!);
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return {
        version: await avatars.remove(
          avatarAccess(identity.user.id, request.params.workspaceId, request.params.botId),
          request.query.expectedCurrentVersionId,
        ),
      };
    });
  });
}

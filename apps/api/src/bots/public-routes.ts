import type { FastifyInstance } from 'fastify';
import { readApiRequestToken } from '../api-tokens/routes.js';
import {
  ApiTokenAuthenticationError,
  ApiTokenScopeError,
  type ApiTokenService,
} from '../api-tokens/service.js';
import { BotAccessError, BotInputError, BotModelError, type BotService } from './service.js';
import { versionId, versionObject, BotVersionNotFoundError } from './version-data.js';
import { BotVersionConflictError, BotAvatarUnavailableError } from './append-version.js';
import type { BotVersionService } from './version-service.js';
import { BotLifecycleConflictError, type BotLifecycleService } from './lifecycle-service.js';

function emptyQuery(query: unknown) {
  if (!versionObject(query) || Object.keys(query).length) throw new BotInputError();
}
function botPageQuery(query: unknown) {
  if (!versionObject(query) || Object.keys(query).some((key) => !['after', 'limit'].includes(key)))
    throw new BotInputError();
  const after = query.after === undefined ? undefined : versionId(query.after);
  if (
    query.limit !== undefined &&
    (typeof query.limit !== 'string' ||
      !/^[1-9][0-9]*$/u.test(query.limit) ||
      Number(query.limit) > 100)
  )
    throw new BotInputError();
  return { after, limit: query.limit === undefined ? 50 : Number(query.limit) };
}

export function registerPublicBotRoutes(
  app: FastifyInstance,
  tokens: ApiTokenService,
  bots: BotService,
  versions: BotVersionService,
  lifecycle: BotLifecycleService,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiTokenAuthenticationError)
        return reply
          .code(401)
          .header('www-authenticate', 'Bearer')
          .send({ error: { code: 'invalid_api_token' } });
      if (error instanceof ApiTokenScopeError)
        return reply.code(403).send({ error: { code: 'insufficient_scope' } });
      if (error instanceof BotAccessError)
        return reply.code(403).send({ error: { code: 'bot_forbidden' } });
      if (error instanceof BotInputError)
        return reply.code(400).send({ error: { code: 'invalid_bot_request' } });
      if (error instanceof BotVersionConflictError)
        return reply.code(409).send({ error: { code: 'bot_version_conflict' } });
      if (error instanceof BotAvatarUnavailableError)
        return reply.code(409).send({ error: { code: 'bot_avatar_unavailable' } });
      if (error instanceof BotVersionNotFoundError)
        return reply.code(404).send({ error: { code: 'bot_version_not_found' } });
      if (error instanceof BotLifecycleConflictError)
        return reply.code(409).send({ error: { code: 'bot_lifecycle_conflict' } });
      if (error instanceof BotModelError)
        return reply
          .code(400)
          .send({ error: { code: 'bot_model_unavailable', reason: error.reason } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        [400, 413, 415].includes(error.statusCode)
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_bot_request' } });
      return reply.code(503).send({ error: { code: 'bot_unavailable' } });
    });
    routes.get<{ Params: { botId: string } }>('/v1/bots/:botId', async (request) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'bots:read',
      );
      emptyQuery(request.query);
      return {
        bot: await bots.get(identity.user.id, identity.workspace.id, request.params.botId, admit),
      };
    });
    routes.post('/v1/bots', { bodyLimit: 262144 }, async (request, reply) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'bots:write',
      );
      emptyQuery(request.query);
      return reply.code(201).send({
        bot: await bots.create(identity.user.id, identity.workspace.id, request.body, admit),
      });
    });
    routes.get('/v1/bots', async (request) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'bots:read',
      );
      const { after, limit } = botPageQuery(request.query);
      const visible = await bots.list(identity.user.id, identity.workspace.id, 'default', admit);
      const page = visible
        .filter((bot) => after === undefined || bot.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const selected = page.slice(0, limit);
      return { bots: selected, nextAfter: page.length > limit ? selected.at(-1)!.id : null };
    });
    routes.patch<{ Params: { botId: string } }>(
      '/v1/bots/:botId',
      { bodyLimit: 262144 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'bots:write',
        );
        emptyQuery(request.query);
        const access = versions.access(
          identity.user.id,
          identity.workspace.id,
          request.params.botId,
        );
        return { version: await versions.edit(access, request.body, admit) };
      },
    );
    routes.get<{ Params: { botId: string } }>('/v1/bots/:botId/versions', async (request) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'bots:read',
      );
      const access = versions.access(identity.user.id, identity.workspace.id, request.params.botId);
      return versions.list(access, request.query, admit);
    });
    routes.get<{ Params: { botId: string; versionId: string } }>(
      '/v1/bots/:botId/versions/:versionId',
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'bots:read',
        );
        emptyQuery(request.query);
        const access = versions.access(
          identity.user.id,
          identity.workspace.id,
          request.params.botId,
        );
        return { version: await versions.get(access, request.params.versionId, admit) };
      },
    );
    routes.post<{ Params: { botId: string } }>(
      '/v1/bots/:botId/archive',
      { bodyLimit: 1024 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'bots:write',
        );
        emptyQuery(request.query);
        if (request.body !== undefined) throw new BotInputError();
        return {
          lifecycle: await lifecycle.archive(
            identity.user.id,
            identity.workspace.id,
            request.params.botId,
            admit,
          ),
        };
      },
    );
  });
}

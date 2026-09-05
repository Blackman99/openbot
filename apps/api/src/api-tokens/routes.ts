import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import {
  ApiTokenAuthenticationError,
  ApiTokenScopeError,
  API_TOKEN_SCOPES,
  type ApiTokenScope,
  ApiTokenAccessError,
  ApiTokenInputError,
  ApiTokenNotFoundError,
  type ApiTokenService,
} from './service.js';

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof ApiTokenAuthenticationError)
    return reply
      .code(401)
      .header('www-authenticate', 'Bearer')
      .send({ error: { code: 'invalid_api_token' } });
  if (error instanceof ApiTokenScopeError)
    return reply.code(403).send({ error: { code: 'insufficient_scope' } });
  if (error instanceof ApiTokenInputError)
    return reply.code(400).send({ error: { code: 'invalid_request' } });
  if (error instanceof ApiTokenAccessError)
    return reply.code(403).send({ error: { code: 'token_forbidden' } });
  if (error instanceof ApiTokenNotFoundError)
    return reply.code(404).send({ error: { code: 'token_not_found' } });
  throw error;
}
export function registerApiTokenRoutes(
  app: FastifyInstance,
  auth: AuthService,
  tokens: ApiTokenService,
  webOrigin: string,
) {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/api-tokens',
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const sessionToken = readSessionToken(request.headers.cookie);
      const session = sessionToken ? await auth.getSession(sessionToken) : undefined;
      if (!session) return reply.code(401).send({ error: { code: 'authentication_required' } });
      try {
        return reply.send({
          tokens: await tokens.list(session.user.id, request.params.workspaceId),
          availableScopes: API_TOKEN_SCOPES,
        });
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.delete<{ Params: { workspaceId: string; tokenId: string } }>(
    '/api/v1/workspaces/:workspaceId/api-tokens/:tokenId',
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const sessionToken = readSessionToken(request.headers.cookie);
      const session = sessionToken ? await auth.getSession(sessionToken) : undefined;
      if (!session) return reply.code(401).send({ error: { code: 'authentication_required' } });
      try {
        await tokens.revoke(session.user.id, request.params.workspaceId, request.params.tokenId);
        return reply.code(204).send();
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/api-tokens',
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const sessionToken = readSessionToken(request.headers.cookie);
      const session = sessionToken ? await auth.getSession(sessionToken) : undefined;
      if (!session) return reply.code(401).send({ error: { code: 'authentication_required' } });
      try {
        return reply
          .code(201)
          .send(await tokens.create(session.user.id, request.params.workspaceId, request.body));
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
}

export function registerPublicIdentityRoute(app: FastifyInstance, tokens: ApiTokenService) {
  app.get('/v1/me', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    try {
      const identity = await authorizeApiRequest(tokens, request, 'me:read');
      return reply.code(200).send(identity);
    } catch (error) {
      return sendError(error, reply);
    }
  });
}
export async function authorizeApiRequest(
  tokens: ApiTokenService,
  request: { url: string; headers: { authorization?: string | undefined } },
  scope: ApiTokenScope,
) {
  return tokens.authorize(readApiRequestToken(request), scope);
}
export function readApiRequestToken(request: {
  url: string;
  headers: { authorization?: string | undefined };
}) {
  const url = new URL(request.url, 'http://localhost');
  if (
    url.searchParams.has('token') ||
    url.searchParams.has('access_token') ||
    url.searchParams.has('api_key')
  )
    throw new ApiTokenAuthenticationError();
  const match = /^Bearer (ob_[A-Za-z0-9_-]{43})$/iu.exec(request.headers.authorization ?? '');
  if (!match?.[1]) throw new ApiTokenAuthenticationError();
  return match[1];
}

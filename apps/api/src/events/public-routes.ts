import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { readApiRequestToken } from '../api-tokens/routes.js';
import {
  ApiTokenAuthenticationError,
  ApiTokenScopeError,
  type ApiTokenService,
} from '../api-tokens/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import type { AuthService } from '../auth/service.js';

function rejectUrlCredentials(url: string) {
  const parsed = new URL(url, 'http://localhost');
  if (
    parsed.searchParams.has('token') ||
    parsed.searchParams.has('access_token') ||
    parsed.searchParams.has('api_key')
  )
    throw new ApiTokenAuthenticationError();
}

function emptyInput(query: unknown, body: unknown) {
  if (
    body !== undefined ||
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    Object.keys(query).length
  )
    throw new ApiTokenAuthenticationError();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
async function admitPublicEvents(
  auth: AuthService,
  tokens: ApiTokenService,
  request: { url: string; headers: Record<string, unknown>; query: unknown; body: unknown },
) {
  rejectUrlCredentials(request.url);
  const authorization = headerValue(request.headers.authorization as string | string[] | undefined);
  if (authorization !== undefined) {
    emptyInput(request.query, request.body);
    await tokens.authorize(
      readApiRequestToken({ url: request.url, headers: { authorization } }),
      'events:read',
    );
    return;
  }
  emptyInput(request.query, request.body);
  const sessionToken = readSessionToken(
    headerValue(request.headers.cookie as string | string[] | undefined),
  );
  if (!sessionToken) throw new ApiTokenAuthenticationError();
  const session = await auth.getSession(sessionToken);
  if (!session) throw new ApiTokenAuthenticationError();
}

export function registerPublicEventRoutes(
  app: FastifyInstance,
  auth: AuthService,
  tokens: ApiTokenService,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store, no-transform');
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
      throw error;
    });
    routes.get('/v1/events', async (request, reply) => {
      await admitPublicEvents(auth, tokens, {
        url: request.url,
        headers: request.headers as Record<string, unknown>,
        query: request.query,
        body: request.body,
      });
      const raw = reply.raw as ServerResponse;
      reply.hijack();
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-store, no-transform',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      });
      raw.flushHeaders();
      // First-slice open acknowledgement only. Durable event IDs, heartbeats,
      // and domain producers land in later API-06 acceptance slices.
      raw.write(': connected\n\n');
      raw.end();
    });
  });
}

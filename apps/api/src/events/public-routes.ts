import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { readApiRequestToken } from '../api-tokens/routes.js';
import {
  ApiTokenAuthenticationError,
  ApiTokenScopeError,
  type ApiTokenIdentity,
  type ApiTokenService,
} from '../api-tokens/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import type { AuthService, SessionIdentity } from '../auth/service.js';
import { WorkspaceEventError } from './protocol.js';
import type { WorkspaceEventService } from './service.js';

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
): Promise<
  { kind: 'token'; identity: ApiTokenIdentity } | { kind: 'session'; identity: SessionIdentity }
> {
  rejectUrlCredentials(request.url);
  const authorization = headerValue(request.headers.authorization as string | string[] | undefined);
  if (authorization !== undefined) {
    emptyInput(request.query, request.body);
    const identity = await tokens.authorize(
      readApiRequestToken({ url: request.url, headers: { authorization } }),
      'events:read',
    );
    return { kind: 'token', identity };
  }
  emptyInput(request.query, request.body);
  const sessionToken = readSessionToken(
    headerValue(request.headers.cookie as string | string[] | undefined),
  );
  if (!sessionToken) throw new ApiTokenAuthenticationError();
  const session = await auth.getSession(sessionToken);
  if (!session) throw new ApiTokenAuthenticationError();
  return { kind: 'session', identity: session };
}

function resolveWorkspaceId(
  admission:
    { kind: 'token'; identity: ApiTokenIdentity } | { kind: 'session'; identity: SessionIdentity },
): string | undefined {
  if (admission.kind === 'token') return admission.identity.workspace.id;
  return admission.identity.workspace?.id;
}

export function registerPublicEventRoutes(
  app: FastifyInstance,
  auth: AuthService,
  tokens: ApiTokenService,
  events?: WorkspaceEventService,
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
      if (error instanceof WorkspaceEventError)
        return reply.code(error.statusCode).send({ error: { code: error.code } });
      throw error;
    });
    routes.get('/v1/events', async (request, reply) => {
      const admission = await admitPublicEvents(auth, tokens, {
        url: request.url,
        headers: request.headers as Record<string, unknown>,
        query: request.query,
        body: request.body,
      });
      const workspaceId = resolveWorkspaceId(admission);
      const lastEventId = request.headers['last-event-id'];
      let frames: string[] = [];
      if (lastEventId !== undefined) {
        if (!workspaceId || !events) throw new WorkspaceEventError('invalid_stream_cursor');
        frames = (await events.resolveReplay(workspaceId, lastEventId)).frames;
      }
      const raw = reply.raw as ServerResponse;
      reply.hijack();
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-store, no-transform',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      });
      raw.flushHeaders();
      // Open acknowledgement carries neither content nor a durable acknowledgement.
      raw.write(': connected\n\n');
      for (const frame of frames) raw.write(frame);
      raw.end();
    });
  });
}

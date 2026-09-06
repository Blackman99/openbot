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
import { deliverWorkspaceEventStream, type WorkspaceEventAdmission } from './delivery.js';
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

function drain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!response.writableNeedDrain) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', ready);
      response.off('close', closed);
      signal.removeEventListener('abort', aborted);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error('Stream closed'));
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    response.once('drain', ready);
    response.once('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function admitPublicEvents(
  auth: AuthService,
  tokens: ApiTokenService,
  request: { url: string; headers: Record<string, unknown>; query: unknown; body: unknown },
): Promise<WorkspaceEventAdmission> {
  rejectUrlCredentials(request.url);
  const authorization = headerValue(request.headers.authorization as string | string[] | undefined);
  if (authorization !== undefined) {
    emptyInput(request.query, request.body);
    const secret = readApiRequestToken({ url: request.url, headers: { authorization } });
    const { identity, admit } = await tokens.authorizeResource(secret, 'events:read');
    return {
      kind: 'token',
      userId: identity.user.id,
      workspaceId: identity.workspace.id,
      admit,
    };
  }
  emptyInput(request.query, request.body);
  const sessionToken = readSessionToken(
    headerValue(request.headers.cookie as string | string[] | undefined),
  );
  if (!sessionToken) throw new ApiTokenAuthenticationError();
  const session = await auth.getSession(sessionToken);
  if (!session?.workspace) throw new ApiTokenAuthenticationError();
  return {
    kind: 'session',
    sessionToken,
    userId: session.user.id,
    workspaceId: session.workspace.id,
  };
}

export function registerPublicEventRoutes(
  app: FastifyInstance,
  auth: AuthService,
  tokens: ApiTokenService,
  events?: WorkspaceEventService,
  timing?: { drainMs?: number; pollMs?: number; heartbeatMs?: number },
) {
  void app.register(async (routes) => {
    const active = new Set<AbortController>();
    routes.addHook('preClose', async () => {
      for (const controller of active) controller.abort();
    });
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
      if (!events) throw new WorkspaceEventError('events_unavailable');
      const admission = await admitPublicEvents(auth, tokens, {
        url: request.url,
        headers: request.headers as Record<string, unknown>,
        query: request.query,
        body: request.body,
      });
      const workspaceId = admission.workspaceId;
      const cursor = await events.openCursor(
        admission,
        workspaceId,
        request.headers['last-event-id'],
      );
      const controller = new AbortController();
      const raw = reply.raw as ServerResponse;
      active.add(controller);
      const stop = () => controller.abort();
      raw.once('close', stop);
      request.raw.once('aborted', stop);
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
      try {
        await deliverWorkspaceEventStream(
          events,
          admission,
          workspaceId,
          cursor,
          {
            queuedBytes: () => raw.writableLength,
            write: (frame) => raw.write(frame),
            drain: (signal) => drain(raw, signal),
            close: () => {
              if (raw.writableNeedDrain) raw.destroy();
              else raw.end();
            },
          },
          controller.signal,
          timing,
        );
      } finally {
        active.delete(controller);
        raw.off('close', stop);
        request.raw.off('aborted', stop);
        controller.abort();
      }
    });
  });
}

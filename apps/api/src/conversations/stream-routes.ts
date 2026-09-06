import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { readSessionToken } from '../auth/session-cookie.js';
import { ConversationStreamError } from './stream-protocol.js';
import { deliverConversationStream, type ConversationStreams } from './stream-delivery.js';

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
function emptyInput(query: unknown, body: unknown) {
  if (
    body !== undefined ||
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    Object.keys(query).length
  )
    throw new ConversationStreamError('invalid_stream_cursor');
}
export function registerConversationStreamRoutes(
  app: FastifyInstance,
  streams: ConversationStreams,
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
      const failure =
        error instanceof ConversationStreamError
          ? error
          : new ConversationStreamError('conversation_stream_unavailable');
      return reply.code(failure.statusCode).send({ error: { code: failure.code } });
    });
    routes.get<{ Params: { workspaceId: string; conversationId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/events/bootstrap',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        if (!token) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const snapshot = await streams.bootstrap(token, request.params);
        emptyInput(request.query, request.body);
        return snapshot;
      },
    );
    routes.get<{ Params: { workspaceId: string; conversationId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/events',
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        if (!token) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const cursor = await streams.check(token, request.params, request.headers['last-event-id']);
        emptyInput(request.query, request.body);
        const controller = new AbortController(),
          raw = reply.raw;
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
        // The private BFF and its Node adapter need a first body chunk to make
        // the open response visible while the provider is still idle. This
        // comment carries neither content nor a durable acknowledgement.
        raw.write(': connected\n\n');
        try {
          await deliverConversationStream(
            streams,
            token,
            request.params,
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
          );
        } finally {
          active.delete(controller);
          raw.off('close', stop);
          request.raw.off('aborted', stop);
          controller.abort();
        }
      },
    );
  });
}

import type { RequestEvent } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME } from './auth-api.js';
import { clearSessionCookie, readSessionCookie } from './session-cookie.js';
import { ConversationApiClient, isConversationUuid } from './conversation-api.js';
import { ConversationStreamDecoder } from '../conversation-stream-codec.js';
import {
  MAX_STREAM_BOOTSTRAP_BYTES,
  MAX_STREAM_FRAME_BYTES,
  encodeConversationStreamCursor,
  parseConversationStreamBootstrap,
  parseConversationStreamCursor,
  type ConversationStreamFrame,
  type ConversationStreamScope,
} from '../conversation-stream-contract.js';
export type ConversationStreamRequestContext = Pick<
  RequestEvent,
  'request' | 'cookies' | 'fetch'
> & { params: { workspaceId: string; conversationId: string } };
export type ConversationStreamMessageRequestContext = ConversationStreamRequestContext & {
  params: ConversationStreamRequestContext['params'] & { messageId: string };
};
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store, no-transform',
  'x-content-type-options': 'nosniff',
};
const ERRORS = {
  400: 'invalid_stream_cursor',
  401: 'authentication_required',
  403: 'conversation_forbidden',
  410: 'cursor_expired',
  503: 'conversation_stream_unavailable',
} as const;
type ErrorStatus = keyof typeof ERRORS;
const MAX_QUEUE_BYTES = 512 * 1024;
const UPSTREAM_TIMEOUT = 30_000;
const DRAIN_TIMEOUT = 10_000;
const encoder = new TextEncoder();
function errorResponse(status: ErrorStatus = 503) {
  return Response.json({ error: { code: ERRORS[status] } }, { status, headers: PRIVATE_HEADERS });
}
function selectedRequest(context: ConversationStreamRequestContext, bootstrap: boolean) {
  const session = readSessionCookie(context.cookies);
  if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return errorResponse(401);
  const scope = {
    workspaceId: context.params.workspaceId,
    conversationId: context.params.conversationId,
  };
  try {
    encodeConversationStreamCursor(scope, 0);
  } catch {
    return errorResponse(400);
  }
  const cursor = context.request.headers.get('last-event-id');
  if (
    context.request.method !== 'GET' ||
    new URL(context.request.url).search !== '' ||
    context.request.body !== null ||
    ![null, '0'].includes(context.request.headers.get('content-length')) ||
    context.request.headers.has('transfer-encoding') ||
    (bootstrap ? cursor !== null : !parseConversationStreamCursor(cursor, scope))
  )
    return errorResponse(400);
  return { scope, session, cursor };
}
function lifetime(signal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return {
    signal: controller.signal,
    deadline() {
      clear();
      timer = setTimeout(abort, UPSTREAM_TIMEOUT);
    },
    clear,
    close() {
      clear();
      signal.removeEventListener('abort', abort);
      abort();
    },
  };
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('conversation_stream_unavailable'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function hasType(response: Response, type: string) {
  return new RegExp(`^${type}(?:;\\s*charset=utf-8)?$`, 'iu').test(
    response.headers.get('content-type') ?? '',
  );
}
async function boundedBody(response: Response, limit: number, signal: AbortSignal) {
  const advertised = response.headers.get('content-length');
  if (
    !response.body ||
    (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > limit))
  )
    throw new Error('invalid_stream_response');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      if (!item.value.byteLength || length + item.value.byteLength > limit)
        throw new Error('invalid_stream_response');
      bytes.set(item.value, length);
      length += item.value.byteLength;
    }
    if (!length || (advertised !== null && Number(advertised) !== length))
      throw new Error('invalid_stream_response');
    return bytes.subarray(0, length);
  } finally {
    void reader.cancel().catch(() => {});
  }
}
async function upstreamError(response: Response, signal: AbortSignal): Promise<ErrorStatus> {
  if (!hasType(response, 'application/json')) return 503;
  const payload: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, 4096, signal)),
  );
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).join(',') !== 'error' ||
    !('error' in payload)
  )
    return 503;
  const error = payload.error;
  if (
    !error ||
    typeof error !== 'object' ||
    Array.isArray(error) ||
    Object.keys(error).join(',') !== 'code' ||
    !('code' in error)
  )
    return 503;
  for (const status of [400, 403, 410, 503] as const)
    if (response.status === status && error.code === ERRORS[status]) return status;
  return 503;
}
function frameBytes(frame: ConversationStreamFrame) {
  const bytes = encoder.encode(
    frame.kind === 'control'
      ? `event: stream.control\ndata: ${JSON.stringify({ schemaVersion: 1, code: frame.code })}\n\n`
      : `id: ${frame.event.cursor}\nevent: ${frame.event.type}\ndata: ${JSON.stringify(frame.event)}\n\n`,
  );
  if (bytes.byteLength > MAX_STREAM_FRAME_BYTES) throw new Error('invalid_stream_frame');
  return bytes;
}
function relay(
  body: ReadableStream<Uint8Array>,
  scope: ConversationStreamScope,
  connection: ReturnType<typeof lifetime>,
) {
  const reader = body.getReader();
  const decoder = new ConversationStreamDecoder(scope);
  let downstream!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false,
    upstreamDone = false;
  let queuedBytes = 0;
  const queue: { bytes: Uint8Array; terminal: boolean }[] = [];
  let drain: ReturnType<typeof setTimeout> | undefined;
  // Forward the API's initial activity as our own data-free comment so the
  // Node response flushes before the first provider delta or 15s heartbeat.
  let lastHeartbeat = Date.now() - 15_000;
  const stop = (close = true) => {
    if (ended) return;
    ended = true;
    clearTimeout(drain);
    connection.signal.removeEventListener('abort', aborted);
    queue.length = 0;
    queuedBytes = 0;
    void reader.cancel().catch(() => {});
    connection.close();
    if (close) downstream.close();
  };
  const aborted = () => stop();
  const awaitDemand = () => {
    clearTimeout(drain);
    drain = setTimeout(() => stop(), DRAIN_TIMEOUT);
  };
  const add = (frames: ConversationStreamFrame[]) => {
    for (const frame of frames) {
      const bytes = frameBytes(frame);
      queuedBytes += bytes.byteLength;
      if (queuedBytes > MAX_QUEUE_BYTES) throw new Error('stream_queue_limit');
      queue.push({ bytes, terminal: frame.kind === 'control' });
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        downstream = controller;
        connection.signal.addEventListener('abort', aborted, { once: true });
        if (connection.signal.aborted) stop();
        else awaitDemand();
      },
      async pull(controller) {
        clearTimeout(drain);
        let inspectedBytes = 0;
        try {
          while (!ended) {
            const next = queue.shift();
            if (next) {
              queuedBytes -= next.bytes.byteLength;
              controller.enqueue(next.bytes);
              connection.clear();
              if (next.terminal || (upstreamDone && !queue.length)) stop();
              else awaitDemand();
              return;
            }
            if (upstreamDone) {
              stop();
              return;
            }
            connection.deadline();
            const item = await abortable(reader.read(), connection.signal);
            if (ended) return;
            if (item.done) {
              upstreamDone = true;
              add(decoder.finish());
              continue;
            }
            inspectedBytes += item.value.byteLength;
            if (!item.value.byteLength || inspectedBytes > MAX_QUEUE_BYTES)
              throw new Error('stream_read_limit');
            add(decoder.feed(item.value));
            if (!queue.length && decoder.atFrameBoundary && Date.now() - lastHeartbeat >= 15_000) {
              // Never relay arbitrary upstream comments. This data-free heartbeat
              // proves transport activity without implying durable acknowledgement.
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
              lastHeartbeat = Date.now();
              connection.clear();
              awaitDemand();
              return;
            }
          }
        } catch {
          if (!ended) {
            controller.enqueue(
              frameBytes({ kind: 'control', code: 'conversation_stream_unavailable' }),
            );
            stop();
          }
        }
      },
      cancel() {
        stop(false);
      },
    },
    { highWaterMark: 0 },
  );
}
async function read(
  context: ConversationStreamRequestContext,
  bootstrap: boolean,
): Promise<Response> {
  const selected = selectedRequest(context, bootstrap);
  if (selected instanceof Response) return selected;
  const connection = lifetime(context.request.signal);
  let response: Response | undefined;
  let transferred = false;
  try {
    connection.signal.throwIfAborted();
    connection.deadline();
    response = await abortable(
      context.fetch(
        `${(process.env.API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/u, '')}/api/v1/workspaces/${selected.scope.workspaceId}/conversations/${selected.scope.conversationId}/events${bootstrap ? '/bootstrap' : ''}`,
        {
          method: 'GET',
          redirect: 'error',
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${selected.session}`,
            ...(!bootstrap && selected.cursor ? { 'last-event-id': selected.cursor } : {}),
          },
          signal: connection.signal,
        },
      ),
      connection.signal,
    );
    if (response.status === 401) {
      clearSessionCookie(context.cookies);
      return errorResponse(401);
    }
    if (response.status !== 200)
      return errorResponse(await upstreamError(response, connection.signal));
    if (bootstrap) {
      if (!hasType(response, 'application/json')) return errorResponse();
      const value = parseConversationStreamBootstrap(
        await boundedBody(response, MAX_STREAM_BOOTSTRAP_BYTES, connection.signal),
        selected.scope,
      );
      return value ? Response.json(value, { headers: PRIVATE_HEADERS }) : errorResponse();
    }
    if (!hasType(response, 'text/event-stream') || !response.body) return errorResponse();
    connection.clear();
    const body = relay(response.body, selected.scope, connection);
    transferred = true;
    return new Response(body, {
      headers: {
        ...PRIVATE_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      },
    });
  } catch {
    return errorResponse();
  } finally {
    if (!transferred) {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      connection.close();
    }
  }
}
export async function readConversationStream(
  context: ConversationStreamRequestContext,
): Promise<Response> {
  return read(context, false);
}
export async function readConversationStreamBootstrap(
  context: ConversationStreamRequestContext,
): Promise<Response> {
  return read(context, true);
}

export async function readConversationStreamMessage(
  context: ConversationStreamMessageRequestContext,
): Promise<Response> {
  const selected = selectedRequest(context, true);
  if (selected instanceof Response) return selected;
  const messageId = context.params.messageId;
  if (!isConversationUuid(messageId) || messageId !== messageId.toLowerCase())
    return errorResponse(400);
  const connection = lifetime(context.request.signal);
  let actualUnauthorized = false;
  // The existing client owns current message/attachment projection. This
  // adapter only bounds its transport and exposes that authorized locator.
  const request: typeof fetch = async (url, options) => {
    const signal = options?.signal
      ? AbortSignal.any([connection.signal, options.signal])
      : connection.signal;
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await abortable(
        context.fetch(url, {
          method: 'GET',
          redirect: 'error',
          headers: { cookie: `${SESSION_COOKIE_NAME}=${selected.session}` },
          signal,
        }),
        signal,
      );
      if (response.status === 401) {
        actualUnauthorized = true;
        return new Response(null, { status: 401 });
      }
      if (!hasType(response, 'application/json')) throw new Error('invalid_stream_response');
      const bytes = await boundedBody(
        response,
        response.status === 200 ? MAX_STREAM_BOOTSTRAP_BYTES : 4096,
        signal,
      );
      return new Response(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    } finally {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  };
  try {
    connection.signal.throwIfAborted();
    connection.deadline();
    const result = await new ConversationApiClient(
      request,
      process.env.API_BASE_URL ?? 'http://localhost:3001',
      process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    ).get(selected.session, selected.scope.workspaceId, selected.scope.conversationId, {
      messageId,
      limit: 1,
    });
    if (actualUnauthorized) {
      clearSessionCookie(context.cookies);
      return errorResponse(401);
    }
    if (result.status === 'forbidden') return errorResponse(403);
    if (result.status === 'invalid') return errorResponse(400);
    if (result.status !== 'available' || !result.value.messages[0]) return errorResponse();
    return Response.json({ message: result.value.messages[0] }, { headers: PRIVATE_HEADERS });
  } catch {
    return errorResponse();
  } finally {
    connection.close();
  }
}

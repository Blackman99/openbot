import { SESSION_COOKIE_NAME } from './auth-api.js';
import { routingKeys } from '../routing-contract.js';
export type RoutingResult<T> =
  | { status: 'available'; value: T }
  | {
      status:
        | 'anonymous'
        | 'invalid'
        | 'forbidden'
        | 'revision-conflict'
        | 'model-unavailable'
        | 'unavailable';
    };

async function readJson(
  response: Response,
  controller: AbortController,
  maximum: number,
): Promise<unknown> {
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  controller.signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const advertised = response.headers.get('content-length');
    if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum))
      throw new Error('invalid_response_size');
    while (true) {
      controller.signal.throwIfAborted();
      const next = await reader.read();
      controller.signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('response_too_large');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    controller.signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

// Both routing surfaces share transport bounds; their domain decoders stay separate.
export class RoutingHttp {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
    private readonly externalSignal?: AbortSignal,
  ) {}
  async send(
    session: string | undefined,
    path: string,
    kind: 'setting' | 'decision',
    body?: unknown,
  ): Promise<RoutingResult<unknown>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (this.externalSignal?.aborted) return { status: 'unavailable' };
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30000);
    try {
      const response = await this.request(this.baseUrl.replace(/\/$/u, '') + path, {
        method: body === undefined ? 'GET' : 'PATCH',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          origin: new URL(this.webOrigin).origin,
          cookie: `${SESSION_COOKIE_NAME}=${session}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401) {
        void response.body?.cancel().catch(() => undefined);
        return { status: 'anonymous' };
      }
      const payload = await readJson(
        response,
        controller,
        response.status === 200 && kind === 'decision' ? 1024 * 1024 : 16 * 1024,
      );
      if (routingKeys(payload, 'error') && routingKeys(payload.error, 'code')) {
        const code = payload.error.code;
        const domain = kind === 'setting' ? 'routing' : 'task';
        if (
          response.status === 403 &&
          (code === `${domain}_forbidden` || code === 'invalid_origin')
        )
          return { status: 'forbidden' };
        if ([400, 413, 415].includes(response.status) && code === `invalid_${domain}_request`)
          return { status: 'invalid' };
        if (kind === 'setting' && response.status === 409) {
          if (code === 'routing_revision_conflict') return { status: 'revision-conflict' };
          if (code === 'routing_model_unavailable') return { status: 'model-unavailable' };
        }
      }
      return response.status === 200
        ? { status: 'available', value: payload }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      this.externalSignal?.removeEventListener('abort', abort);
      controller.abort();
      clearTimeout(timer);
    }
  }
}

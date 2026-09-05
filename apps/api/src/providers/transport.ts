import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { classifyTransportFailure } from './failure-taxonomy.js';
import { ProviderError, ProviderUrlPolicy } from './url-policy.js';

export async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw new ProviderError('provider_cancelled');
  }
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new ProviderError('provider_cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
export interface ProviderRequest {
  baseUrl: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  stream: boolean;
  maxResponseBytes?: number;
}
export interface ProviderResponse {
  status: number;
  raw: string;
  failureCode?: string;
}

export class PinnedProviderTransport {
  constructor(private readonly policy: ProviderUrlPolicy) {}

  async send(
    input: ProviderRequest,
    signal: AbortSignal,
    onChunk?: (chunk: string) => void | Promise<void>,
  ): Promise<ProviderResponse> {
    signal.throwIfAborted();
    const target = await withAbort(
      this.policy.resolve(`${input.baseUrl.replace(/\/+$/u, '')}${input.path}`),
      signal,
    );
    signal.throwIfAborted();
    const payload = JSON.stringify(input.body);
    const maximum = 8 * 1024 * 1024;
    const limit =
      input.maxResponseBytes !== undefined &&
      Number.isSafeInteger(input.maxResponseBytes) &&
      input.maxResponseBytes > 0
        ? Math.min(maximum, input.maxResponseBytes)
        : maximum;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let status = 0;
      let finished = false;
      const finish = (failureCode?: string) => {
        if (finished) return;
        finished = true;
        resolve({
          status,
          raw: Buffer.concat(chunks).toString('utf8'),
          ...(failureCode ? { failureCode } : {}),
        });
      };
      const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(
        target.url,
        {
          method: 'POST',
          signal,
          agent: false,
          // Validate every DNS answer, pin the connection, reject redirects, and ignore proxies.
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address: target.address, family: target.family }]);
            else callback(null, target.address, target.family);
          },
          headers: {
            ...input.headers,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            accept: input.stream ? 'text/event-stream' : 'application/json',
          },
        },
        (response) => {
          status = response.statusCode ?? 0;
          const consume = async () => {
            const decoder = new TextDecoder();
            try {
              for await (const chunk of response) {
                if (finished) return;
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                chunks.push(buffer.subarray(0, Math.max(0, limit - bytes)));
                bytes += buffer.length;
                if (bytes > limit) {
                  finish('provider_response_too_large');
                  response.destroy();
                  request.destroy();
                  return;
                }
                if (status >= 200 && status < 300 && onChunk)
                  await withAbort(
                    Promise.resolve(onChunk(decoder.decode(buffer, { stream: true }))),
                    signal,
                  );
              }
              if (!finished && status >= 200 && status < 300 && onChunk) {
                const tail = decoder.decode();
                if (tail) await withAbort(Promise.resolve(onChunk(tail)), signal);
              }
              finish();
            } catch (error) {
              finish(classifyTransportFailure(error, { stream: input.stream, status }).code);
              response.destroy();
              request.destroy();
            }
          };
          void consume();
        },
      );
      request.on('error', (error) =>
        finish(classifyTransportFailure(error, { stream: input.stream, status }).code),
      );
      request.end(payload);
    });
  }
}

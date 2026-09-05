import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { redactProviderText, type ProviderCredentials } from './secrets.js';
import { ProviderError, ProviderUrlPolicy } from './url-policy.js';

export interface ProbeInput extends ProviderCredentials {
  baseUrl: string;
  modelId: string;
}
export interface ProbeResult {
  ok: boolean;
  code: string;
  raw: string;
}
export interface ProbeReport {
  testedAt: string;
  text: ProbeResult;
  action: ProbeResult;
}
export interface ConnectionProbe {
  run(input: ProbeInput, signal?: AbortSignal): Promise<ProbeReport>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstChoice(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  return isRecord(value.choices[0]) ? value.choices[0] : undefined;
}

function textStreamSucceeded(raw: string): boolean {
  let text = '';
  let finished = false;
  let done = false;
  for (const frame of raw.replace(/\r\n/gu, '\n').split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    if (done) return false;
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    const event: unknown = JSON.parse(data);
    if (isRecord(event) && Object.hasOwn(event, 'error')) return false;
    const choice = firstChoice(event);
    if (!choice) continue;
    if (isRecord(choice.delta) && typeof choice.delta.content === 'string')
      text += choice.delta.content;
    if (choice.finish_reason === 'stop') finished = true;
  }
  return Boolean(text.trim()) && finished && done;
}

function actionSucceeded(raw: string): boolean {
  const choice = firstChoice(JSON.parse(raw));
  if (
    !choice ||
    choice.finish_reason !== 'tool_calls' ||
    !isRecord(choice.message) ||
    !Array.isArray(choice.message.tool_calls)
  )
    return false;
  const call: unknown = choice.message.tool_calls[0];
  if (
    !isRecord(call) ||
    call.type !== 'function' ||
    !isRecord(call.function) ||
    call.function.name !== 'openbot_probe' ||
    typeof call.function.arguments !== 'string'
  )
    return false;
  const args: unknown = JSON.parse(call.function.arguments);
  return isRecord(args) && args.ok === true && Object.keys(args).length === 1;
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
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

export class OpenAiChatProbe implements ConnectionProbe {
  constructor(
    private readonly policy: ProviderUrlPolicy,
    private readonly options: { timeoutMs?: number; clock?: () => Date } = {},
  ) {}

  async run(input: ProbeInput, signal?: AbortSignal): Promise<ProbeReport> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? 15_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const runProbe = async (stream: boolean): Promise<ProbeResult> => {
      let raw = '';
      try {
        const response = await this.send(input, stream, controller.signal);
        raw = response.raw;
        if (response.failureCode) throw new ProviderError(response.failureCode);
        if (response.status === 401 || response.status === 403)
          throw new ProviderError('provider_authentication_failed');
        if (response.status < 200 || response.status >= 300)
          throw new ProviderError('provider_request_failed');
        const ok = stream ? textStreamSucceeded(raw) : actionSucceeded(raw);
        return {
          ok,
          code: ok
            ? 'passed'
            : stream
              ? 'provider_interrupted_stream'
              : 'provider_action_unsupported',
          raw: redactProviderText(raw, input),
        };
      } catch (error) {
        const code = timedOut
          ? 'provider_timeout'
          : controller.signal.aborted
            ? 'provider_cancelled'
            : error instanceof ProviderError
              ? error.code
              : 'provider_invalid_response';
        return { ok: false, code, raw: redactProviderText(raw, input) };
      }
    };
    try {
      return {
        testedAt: (this.options.clock?.() ?? new Date()).toISOString(),
        text: await runProbe(true),
        action: await runProbe(false),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async send(
    input: ProbeInput,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<{ status: number; raw: string; failureCode?: string }> {
    signal.throwIfAborted();
    const target = await withAbort(
      this.policy.resolve(`${input.baseUrl.replace(/\/+$/u, '')}/chat/completions`),
      signal,
    );
    signal.throwIfAborted();
    const payload = JSON.stringify({
      model: input.modelId,
      messages: [
        {
          role: 'user',
          content: stream ? 'Reply with OK.' : 'Call openbot_probe with ok set to true.',
        },
      ],
      stream,
      ...(stream
        ? {}
        : {
            tools: [
              {
                type: 'function',
                function: {
                  name: 'openbot_probe',
                  description: 'Check structured action support.',
                  parameters: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok'],
                    additionalProperties: false,
                  },
                },
              },
            ],
            tool_choice: { type: 'function', function: { name: 'openbot_probe' } },
          }),
    });
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let status = 0;
      const finish = (failureCode?: string) =>
        resolve({
          status,
          raw: Buffer.concat(chunks).toString('utf8'),
          ...(failureCode ? { failureCode } : {}),
        });
      const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(
        target.url,
        {
          method: 'POST',
          signal,
          agent: false,
          // Resolve once, validate every answer, and connect to that address. Never
          // follow redirects or inherit environment proxy settings.
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address: target.address, family: target.family }]);
            else callback(null, target.address, target.family);
          },
          headers: {
            ...input.headers,
            ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            accept: stream ? 'text/event-stream' : 'application/json',
          },
        },
        (response) => {
          status = response.statusCode ?? 0;
          response.on('data', (chunk: Buffer) => {
            const remaining = Math.max(0, 65_536 - bytes);
            chunks.push(chunk.subarray(0, remaining));
            bytes += chunk.length;
            if (bytes > 65_536) {
              finish('provider_response_too_large');
              response.destroy();
              request.destroy();
            }
          });
          response.on('error', () =>
            finish(stream ? 'provider_interrupted_stream' : 'provider_unreachable'),
          );
          response.on('end', () => finish());
        },
      );
      request.on('error', () =>
        finish(status && stream ? 'provider_interrupted_stream' : 'provider_unreachable'),
      );
      request.end(payload);
    });
  }
}

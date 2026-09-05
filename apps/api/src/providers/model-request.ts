import {
  isRecord,
  type ModelDecoder,
  type ModelEventConsumer,
  type ModelFailure,
  type ModelInput,
  type ModelResponse,
} from './model-events.js';
import { redactProviderText } from './secrets.js';
import { PinnedProviderTransport, withAbort, type ProviderRequest } from './transport.js';
import { ProviderError, type ProviderUrlPolicy } from './url-policy.js';

export function modelFailure(code: string): ModelFailure {
  return {
    code,
    category:
      code === 'provider_action_unsupported' || code === 'provider_protocol_unsupported'
        ? 'unsupported_capability'
        : [
              'provider_rate_limited',
              'provider_unavailable',
              'provider_timeout',
              'provider_unreachable',
              'provider_interrupted_stream',
            ].includes(code)
          ? 'retryable'
          : 'non_retryable',
  };
}
export function upstreamErrorCode(value: unknown): string {
  const error = isRecord(value) && isRecord(value.error) ? value.error : value;
  if (!isRecord(error)) return 'provider_request_failed';
  if (error.code === 'rate_limit_exceeded' || error.code === 'rate_limit_error')
    return 'provider_rate_limited';
  if (error.code === 'server_error' || error.code === 'overloaded_error')
    return 'provider_unavailable';
  if (error.code === 'invalid_api_key') return 'provider_authentication_failed';
  if (
    ['unsupported_parameter', 'unsupported_value'].includes(String(error.code)) &&
    ['tools', 'tool_choice'].includes(String(error.param))
  )
    return 'provider_action_unsupported';
  return 'provider_request_failed';
}
export interface ModelRequest extends ProviderRequest {
  input: ModelInput;
  policy: ProviderUrlPolicy;
  decoder: ModelDecoder;
  options?: { timeoutMs?: number };
}
export async function executeModelRequest(
  request: ModelRequest,
  signal?: AbortSignal,
  onEvent?: ModelEventConsumer,
): Promise<ModelResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.options?.timeoutMs ?? 15_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const result: ModelResponse = { events: [], raw: '' };
  const emit = async (events: ModelResponse['events']) => {
    for (const event of events) {
      controller.signal.throwIfAborted();
      result.events.push(event);
      await withAbort(Promise.resolve(onEvent?.(event)), controller.signal);
    }
  };
  try {
    const response = await new PinnedProviderTransport(request.policy).send(
      {
        ...request,
        ...(request.input.maxResponseBytes === undefined
          ? {}
          : { maxResponseBytes: request.input.maxResponseBytes }),
      },
      controller.signal,
      async (chunk) => {
        try {
          await emit(request.decoder.feed(chunk));
        } catch (error) {
          throw error instanceof ProviderError
            ? error
            : new ProviderError('provider_invalid_response');
        }
      },
    );
    result.raw = redactProviderText(response.raw, request.input);
    if (controller.signal.aborted) throw new ProviderError('provider_cancelled');
    if (response.failureCode) throw new ProviderError(response.failureCode);
    if (response.status === 401 || response.status === 403)
      throw new ProviderError('provider_authentication_failed');
    if (response.status === 429) throw new ProviderError('provider_rate_limited');
    if (response.status >= 500) throw new ProviderError('provider_unavailable');
    if (response.status < 200 || response.status >= 300) {
      let code = 'provider_request_failed';
      try {
        code = upstreamErrorCode(JSON.parse(response.raw));
      } catch {
        /* The safe status code is sufficient for non-JSON failures. */
      }
      throw new ProviderError(code);
    }
    await emit(request.decoder.finish(response.raw));
  } catch (error) {
    const code = timedOut
      ? 'provider_timeout'
      : controller.signal.aborted
        ? 'provider_cancelled'
        : error instanceof ProviderError
          ? error.code
          : 'provider_invalid_response';
    result.error = modelFailure(code);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  return result;
}

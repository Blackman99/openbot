import {
  type ModelDecoder,
  type ModelEventConsumer,
  type ModelInput,
  type ModelResponse,
} from './model-events.js';
import { httpStatusFailureCode, modelFailure } from './failure-taxonomy.js';
import { redactProviderText } from './secrets.js';
import { PinnedProviderTransport, withAbort, type ProviderRequest } from './transport.js';
import { ProviderError, type ProviderUrlPolicy } from './url-policy.js';

export {
  classifyTransportFailure,
  httpStatusFailureCode,
  isAutomaticRetryFailure,
  modelFailure,
  upstreamErrorCode,
} from './failure-taxonomy.js';
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
    if (response.status < 200 || response.status >= 300)
      throw new ProviderError(httpStatusFailureCode(response.status, response.raw).code);
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

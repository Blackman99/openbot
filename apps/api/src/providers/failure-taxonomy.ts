import { isRecord, type ModelFailure } from './model-events.js';
import { ProviderError } from './url-policy.js';

const RETRYABLE = new Set([
  'provider_rate_limited',
  'provider_unavailable',
  'provider_connection_reset',
]);
const TEMPORARY_NETWORK = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

export function isAutomaticRetryFailure(failure?: ModelFailure): boolean {
  return !!failure && RETRYABLE.has(failure.code);
}

export function modelFailure(code: string): ModelFailure {
  return {
    code,
    category:
      code === 'provider_action_unsupported' || code === 'provider_protocol_unsupported'
        ? 'unsupported_capability'
        : RETRYABLE.has(code)
          ? 'retryable'
          : 'non_retryable',
  };
}

export function httpStatusFailureCode(status: number, raw = ''): ModelFailure {
  if (status === 401 || status === 403) return modelFailure('provider_authentication_failed');
  if (status === 429) return modelFailure('provider_rate_limited');
  if (status === 500 || status === 502 || status === 503 || status === 504)
    return modelFailure('provider_unavailable');
  if (status === 529) {
    try {
      const body: unknown = JSON.parse(raw);
      const error = isRecord(body) && isRecord(body.error) ? body.error : body;
      if (
        isRecord(error) &&
        (error.type === 'overloaded_error' || error.code === 'overloaded_error')
      )
        return modelFailure('provider_unavailable');
    } catch {
      /* A 529 without an overloaded envelope stays terminal. */
    }
    return modelFailure('provider_request_failed');
  }
  if (status < 200 || status >= 300) {
    try {
      return modelFailure(upstreamErrorCode(JSON.parse(raw)));
    } catch {
      return modelFailure('provider_request_failed');
    }
  }
  return modelFailure('provider_request_failed');
}

export function classifyTransportFailure(
  error: unknown,
  context: { stream: boolean; status: number },
): ModelFailure {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  if (TEMPORARY_NETWORK.has(code)) return modelFailure('provider_connection_reset');
  if (
    /^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_|ERR_TLS|ERR_SSL|DEPTH_ZERO_SELF_SIGNED_CERT)/u.test(
      code,
    )
  )
    return modelFailure('provider_tls_failed');
  if (error instanceof ProviderError) return modelFailure(error.code);
  return modelFailure(
    context.status && context.stream ? 'provider_interrupted_stream' : 'provider_unreachable',
  );
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

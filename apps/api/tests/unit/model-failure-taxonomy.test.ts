import { describe, expect, it } from 'vitest';
import {
  classifyTransportFailure,
  httpStatusFailureCode,
  modelFailure,
} from '../../src/providers/model-request.js';

describe('COL-10 closed provider failure taxonomy', () => {
  it.each([
    ['provider_rate_limited', 'retryable'],
    ['provider_unavailable', 'retryable'],
    ['provider_connection_reset', 'retryable'],
    ['provider_timeout', 'non_retryable'],
    ['provider_unreachable', 'non_retryable'],
    ['provider_interrupted_stream', 'non_retryable'],
    ['provider_tls_failed', 'non_retryable'],
    ['provider_authentication_failed', 'non_retryable'],
    ['provider_request_failed', 'non_retryable'],
    ['provider_invalid_response', 'non_retryable'],
    ['provider_cancelled', 'non_retryable'],
    ['provider_url_not_allowed', 'non_retryable'],
    ['unknown_structured_error', 'non_retryable'],
  ] as const)('classifies %s as %s', (code, category) => {
    expect(modelFailure(code)).toEqual({ code, category });
  });

  it('retries only the documented transient HTTP statuses', () => {
    expect(httpStatusFailureCode(429)).toEqual(modelFailure('provider_rate_limited'));
    for (const status of [500, 502, 503, 504])
      expect(httpStatusFailureCode(status)).toEqual(modelFailure('provider_unavailable'));
    expect(httpStatusFailureCode(401)).toEqual(modelFailure('provider_authentication_failed'));
    expect(httpStatusFailureCode(403)).toEqual(modelFailure('provider_authentication_failed'));
    expect(httpStatusFailureCode(400)).toEqual(modelFailure('provider_request_failed'));
    expect(httpStatusFailureCode(501)).toEqual(modelFailure('provider_request_failed'));
    expect(httpStatusFailureCode(505)).toEqual(modelFailure('provider_request_failed'));
    expect(httpStatusFailureCode(529)).toEqual(modelFailure('provider_request_failed'));
    expect(
      httpStatusFailureCode(529, JSON.stringify({ error: { type: 'overloaded_error' } })),
    ).toEqual(modelFailure('provider_unavailable'));
    expect(httpStatusFailureCode(529, JSON.stringify({ error: { type: 'api_error' } }))).toEqual(
      modelFailure('provider_request_failed'),
    );
  });

  it('retries only positively classified temporary network failures', () => {
    expect(classifyTransportFailure({ code: 'ECONNRESET' }, { stream: false, status: 0 })).toEqual(
      modelFailure('provider_connection_reset'),
    );
    expect(classifyTransportFailure({ code: 'ETIMEDOUT' }, { stream: true, status: 200 })).toEqual(
      modelFailure('provider_connection_reset'),
    );
    expect(
      classifyTransportFailure(
        { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
        { stream: false, status: 0 },
      ),
    ).toEqual(modelFailure('provider_tls_failed'));
    expect(
      classifyTransportFailure(
        { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
        { stream: true, status: 0 },
      ),
    ).toEqual(modelFailure('provider_tls_failed'));
    expect(classifyTransportFailure({ code: 'ENOTFOUND' }, { stream: false, status: 0 })).toEqual(
      modelFailure('provider_unreachable'),
    );
    expect(classifyTransportFailure({ code: 'EPROTO' }, { stream: true, status: 200 })).toEqual(
      modelFailure('provider_interrupted_stream'),
    );
  });
});

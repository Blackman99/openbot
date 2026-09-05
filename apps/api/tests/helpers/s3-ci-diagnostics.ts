// Temporary test-only diagnostics for Verify 33948926135 / job 101260139298.
// Remove after the real-service cause has a deterministic regression and fix.
import { errorMonitor } from 'node:events';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { vi } from 'vitest';
export const S3_CI_DIAGNOSTIC_TAG = '[DEBUG-s3-ci-33948926135]';
const names = [
  'Error',
  'TimeoutError',
  'AbortError',
  'NoSuchKey',
  'PreconditionFailed',
  'ConditionalRequestConflict',
  'AccessDenied',
  'InvalidRequest',
  'SlowDown',
  'InternalError',
  'ServiceUnavailable',
  'S3ServiceException',
] as const;
const codes = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ERR_STREAM_PREMATURE_CLOSE',
] as const;
export function classifyS3ErrorForCi(error: unknown) {
  if (!error || typeof error !== 'object') return { name: 'other', code: 'other' };
  // Confirmed in @smithy/core 3.33.3 createChecksumStream and
  // @aws-sdk/checksums 3.1000.29 validateChecksumFromResponse. No values are copied.
  const checksum =
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.startsWith('Checksum mismatch: expected "');
  const name = checksum
    ? 'checksum-mismatch'
    : (names.find((name) => 'name' in error && error.name === name) ?? 'other');
  const code = codes.find((code) => 'code' in error && error.code === code) ?? 'other';
  return { name, code };
}
interface Diagnostic {
  operation: 'put' | 'get' | 'delete';
  stage: 'send' | 'body';
  httpStatus: number | null;
  name: string;
  code: string;
}
function httpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}
export function observeS3ForCi() {
  const events: Diagnostic[] = [];
  const record = (event: Diagnostic) => {
    if (events.length < 64) events.push(event);
  };
  const original = S3Client.prototype.send;
  const spy = vi.spyOn(S3Client.prototype, 'send').mockImplementation(function (
    this: S3Client,
    ...args: Parameters<S3Client['send']>
  ) {
    const command = args[0];
    const operation =
      command.constructor.name === 'PutObjectCommand'
        ? 'put'
        : command.constructor.name === 'GetObjectCommand'
          ? 'get'
          : command.constructor.name === 'DeleteObjectCommand'
            ? 'delete'
            : undefined;
    // The store uses promise sends. Leave all callback/other commands untouched.
    if (!operation || typeof args[1] === 'function' || typeof args[2] === 'function')
      return Reflect.apply(original, this, args);
    let status: number | null = null;
    command.middlewareStack.add(
      (next) => async (input) => {
        const result = await next(input);
        const response = result.response;
        if (response && typeof response === 'object' && 'statusCode' in response)
          status = httpStatus(response.statusCode);
        return result;
      },
      { step: 'deserialize', priority: 'low', name: 's3CiStatus33948926135' },
    );
    const result: unknown = Reflect.apply(original, this, args);
    if (!(result instanceof Promise)) return result;
    void result.then(
      (output: unknown) => {
        record({ operation, stage: 'send', httpStatus: status, name: 'none', code: 'none' });
        if (
          output &&
          typeof output === 'object' &&
          'Body' in output &&
          output.Body instanceof Readable
        ) {
          const body = output.Body;
          // errorMonitor neither consumes data nor handles/suppresses an error event.
          const observeError = (error: unknown) =>
            record({
              operation,
              stage: 'body',
              httpStatus: status,
              ...classifyS3ErrorForCi(error),
            });
          body.once(errorMonitor, observeError);
          body.once('close', () => body.off(errorMonitor, observeError));
        }
      },
      (error: unknown) => {
        record({ operation, stage: 'send', httpStatus: status, ...classifyS3ErrorForCi(error) });
      },
    );
    // Preserve the original promise, result identity, and rejection propagation.
    return result;
  });
  return {
    events,
    reset() {
      events.length = 0;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

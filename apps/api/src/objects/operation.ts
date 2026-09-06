import { DEFAULT_MAX_OBJECT_BYTES, ObjectStoreError, ObjectNotFoundError } from './store.js';
export interface ObjectStoreOptions {
  maxObjectBytes?: number;
  timeoutMs?: number;
}
export function objectStoreOptions(options: ObjectStoreOptions) {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    !Number.isSafeInteger(maxObjectBytes) ||
    maxObjectBytes < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  )
    throw new ObjectStoreError();
  return { maxObjectBytes, timeoutMs };
}
export function validateReadBound(maxBytes: number, maximum: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximum)
    throw new ObjectStoreError('invalid_object_size');
}
export function copyObjectBytes(bytes: Uint8Array, maximum: number): Buffer {
  if (!(bytes instanceof Uint8Array)) throw new ObjectStoreError('invalid_object_size');
  if (bytes.byteLength > maximum) throw new ObjectStoreError('object_too_large');
  return Buffer.from(bytes);
}
export async function objectOperation<T>(
  timeoutMs: number,
  external: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (external?.aborted) throw new ObjectStoreError('object_operation_aborted');
  const deadline = new AbortController();
  const signal = external ? AbortSignal.any([external, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let abort: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new ObjectStoreError(
          external?.aborted ? 'object_operation_aborted' : 'object_store_unavailable',
        ),
      );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(signal)), stopped]);
  } catch (cause) {
    if (external?.aborted) throw new ObjectStoreError('object_operation_aborted');
    // SDK deserializers can mutate error messages and attach hidden raw responses.
    if (cause instanceof ObjectNotFoundError) throw new ObjectNotFoundError();
    if (cause instanceof ObjectStoreError) throw new ObjectStoreError(cause.code);
    throw new ObjectStoreError();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
export function systemErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

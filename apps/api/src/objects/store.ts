import { randomUUID } from 'node:crypto';

export const DEFAULT_MAX_OBJECT_BYTES = 2 * 1024 * 1024;
export interface ObjectKey {
  workspaceId: string;
  objectId: string;
}
export interface ObjectStore {
  /** Stable nonsecret identity; publication must retain and match the configured backend. */
  readonly identity: string;
  /** Saves a fresh internal object key; an existing object is never overwritten. */
  save(key: ObjectKey, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Reads privately, rejecting content larger than the caller's explicit bound. */
  read(key: ObjectKey, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  /** Missing objects are already deleted. */
  delete(key: ObjectKey, signal?: AbortSignal): Promise<void>;
}
export type ObjectStoreErrorCode =
  | 'object_store_unavailable'
  | 'invalid_object_key'
  | 'invalid_object_size'
  | 'object_too_large'
  | 'object_already_exists'
  | 'object_operation_aborted'
  | 'object_not_found';
export class ObjectStoreError extends Error {
  constructor(readonly code: ObjectStoreErrorCode = 'object_store_unavailable') {
    super(code);
    this.name = 'ObjectStoreError';
  }
}
export class ObjectNotFoundError extends ObjectStoreError {
  constructor() {
    super('object_not_found');
    this.name = 'ObjectNotFoundError';
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function normalizeObjectKey(key: ObjectKey): ObjectKey {
  if (
    !key ||
    typeof key.workspaceId !== 'string' ||
    typeof key.objectId !== 'string' ||
    !uuid.test(key.workspaceId) ||
    !uuid.test(key.objectId)
  )
    throw new ObjectStoreError('invalid_object_key');
  return { workspaceId: key.workspaceId.toLowerCase(), objectId: key.objectId.toLowerCase() };
}
export function createObjectKey(workspaceId: string): ObjectKey {
  return normalizeObjectKey({ workspaceId, objectId: randomUUID() });
}

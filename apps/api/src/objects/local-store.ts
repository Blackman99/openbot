import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ObjectNotFoundError,
  ObjectStoreError,
  normalizeObjectKey,
  type ObjectKey,
  type ObjectStore,
} from './store.js';
import {
  copyObjectBytes,
  objectOperation,
  objectStoreOptions,
  systemErrorCode,
  validateReadBound,
  type ObjectStoreOptions,
} from './operation.js';
export const DEFAULT_LOCAL_OBJECT_PATH = '/var/lib/openbot/objects';
export class LocalObjectStore implements ObjectStore {
  readonly identity: string;
  private readonly root: string;
  private readonly options: ReturnType<typeof objectStoreOptions>;
  constructor(rootDirectory = DEFAULT_LOCAL_OBJECT_PATH, options: ObjectStoreOptions = {}) {
    if (!isAbsolute(rootDirectory) || rootDirectory.includes('\0')) throw new ObjectStoreError();
    this.root = resolve(rootDirectory);
    this.identity = `local:${createHash('sha256').update(this.root).digest('hex')}`;
    this.options = objectStoreOptions(options);
  }
  async save(key: ObjectKey, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    return objectOperation(this.options.timeoutMs, signal, async (operationSignal) => {
      const normalized = normalizeObjectKey(key);
      const body = copyObjectBytes(bytes, this.options.maxObjectBytes);
      const directory = await this.directory(normalized.workspaceId, true);
      operationSignal.throwIfAborted();
      const path = join(directory, normalized.objectId);
      let file;
      try {
        file = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (systemErrorCode(error) === 'EEXIST')
          throw new ObjectStoreError('object_already_exists');
        throw error;
      }
      try {
        await file.writeFile(body, { signal: operationSignal });
        await file.sync();
        operationSignal.throwIfAborted();
      } catch (error) {
        // This invocation created the key exclusively; failed writes can only remove its own staged object.
        await unlink(path).catch(() => undefined);
        throw error;
      } finally {
        await file.close();
      }
    });
  }
  async read(key: ObjectKey, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    return objectOperation(this.options.timeoutMs, signal, async (operationSignal) => {
      const normalized = normalizeObjectKey(key);
      validateReadBound(maxBytes, this.options.maxObjectBytes);
      try {
        const directory = await this.directory(normalized.workspaceId, false);
        const file = await open(
          join(directory, normalized.objectId),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await file.stat();
          if (!info.isFile() || (info.mode & 0o077) !== 0) throw new ObjectStoreError();
          if (info.size > maxBytes) throw new ObjectStoreError('object_too_large');
          const chunks: Buffer[] = [];
          let size = 0;
          while (true) {
            operationSignal.throwIfAborted();
            const chunk = Buffer.alloc(Math.min(65_536, maxBytes - size + 1));
            const { bytesRead } = await file.read(chunk);
            if (bytesRead === 0) return Buffer.concat(chunks, size);
            size += bytesRead;
            if (size > maxBytes) throw new ObjectStoreError('object_too_large');
            chunks.push(chunk.subarray(0, bytesRead));
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        if (systemErrorCode(error) === 'ENOENT') throw new ObjectNotFoundError();
        throw error;
      }
    });
  }
  async delete(key: ObjectKey, signal?: AbortSignal): Promise<void> {
    return objectOperation(this.options.timeoutMs, signal, async (operationSignal) => {
      const normalized = normalizeObjectKey(key);
      try {
        const directory = await this.directory(normalized.workspaceId, false);
        const path = join(directory, normalized.objectId);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new ObjectStoreError();
        operationSignal.throwIfAborted();
        await unlink(path);
      } catch (error) {
        if (systemErrorCode(error) !== 'ENOENT') throw error;
      }
    });
  }
  private async directory(workspaceId: string, create: boolean): Promise<string> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.privateDirectory(this.root, create);
    const workspace = join(this.root, workspaceId);
    if (create)
      await mkdir(workspace, { mode: 0o700 }).catch((error: unknown) => {
        if (systemErrorCode(error) !== 'EEXIST') throw error;
      });
    await this.privateDirectory(workspace, create);
    return workspace;
  }
  private async privateDirectory(path: string, tighten: boolean): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ObjectStoreError();
    if (tighten) await chmod(path, 0o700);
    else if ((info.mode & 0o077) !== 0) throw new ObjectStoreError();
  }
}

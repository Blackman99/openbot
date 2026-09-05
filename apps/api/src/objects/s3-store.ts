import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
  validateReadBound,
  type ObjectStoreOptions,
} from './operation.js';
export interface S3ObjectStoreConfig {
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export function normalizeS3Config(config: S3ObjectStoreConfig): S3ObjectStoreConfig {
  if (
    typeof config.bucket !== 'string' ||
    typeof config.region !== 'string' ||
    typeof config.accessKeyId !== 'string' ||
    typeof config.secretAccessKey !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket) ||
    config.bucket.includes('..') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/u.test(config.region) ||
    !config.accessKeyId ||
    !config.secretAccessKey
  )
    throw new ObjectStoreError();
  let endpoint: string | undefined;
  if (config.endpoint !== undefined) {
    try {
      const url = new URL(config.endpoint);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new ObjectStoreError();
      endpoint = url.href.replace(/\/+$/u, '');
    } catch {
      throw new ObjectStoreError();
    }
  }
  return { ...config, ...(endpoint === undefined ? {} : { endpoint }) };
}
function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('$metadata' in error)) return undefined;
  const metadata = error.$metadata;
  return metadata &&
    typeof metadata === 'object' &&
    'httpStatusCode' in metadata &&
    typeof metadata.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined;
}
export class S3ObjectStore implements ObjectStore {
  readonly identity: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly options: ReturnType<typeof objectStoreOptions>;
  constructor(input: S3ObjectStoreConfig, options: ObjectStoreOptions = {}) {
    const config = normalizeS3Config(input);
    this.options = objectStoreOptions(options);
    this.bucket = config.bucket;
    this.identity = `s3:${createHash('sha256')
      .update(JSON.stringify([config.endpoint ?? 'aws', config.bucket, config.region]))
      .digest('hex')}`;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
      },
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: this.options.timeoutMs,
        requestTimeout: this.options.timeoutMs,
      },
    });
    // The SDK eagerly collects error bodies before throwing. Bound that collector too.
    this.client.middlewareStack.add(
      (next) => async (args) => {
        const result = await next(args);
        const response = result.response;
        if (
          response &&
          typeof response === 'object' &&
          'statusCode' in response &&
          typeof response.statusCode === 'number' &&
          response.statusCode >= 400 &&
          'body' in response &&
          response.body instanceof Readable
        ) {
          const source = response.body;
          let bytes = 0;
          const limited = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              callback(bytes > 65_536 ? new ObjectStoreError() : null, chunk);
            },
          });
          source.once('error', () => limited.destroy(new ObjectStoreError()));
          limited.once('error', () => source.destroy());
          limited.once('close', () => source.destroy());
          response.body = source.pipe(limited);
        }
        return result;
      },
      { step: 'deserialize', priority: 'low', name: 'boundedObjectErrorResponse' },
    );
  }
  async save(key: ObjectKey, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    return objectOperation(this.options.timeoutMs, signal, async (operationSignal) => {
      const normalized = normalizeObjectKey(key);
      const body = copyObjectBytes(bytes, this.options.maxObjectBytes);
      try {
        // No ACL grants: S3's private default also supports bucket-owner-enforced buckets.
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.path(normalized),
            Body: body,
            ContentLength: body.length,
            ContentType: 'application/octet-stream',
            CacheControl: 'private, no-store',
            IfNoneMatch: '*',
          }),
          { abortSignal: operationSignal },
        );
      } catch (error) {
        if (statusCode(error) === 409 || statusCode(error) === 412)
          throw new ObjectStoreError('object_already_exists');
        throw error;
      }
    });
  }
  async read(key: ObjectKey, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    return objectOperation(this.options.timeoutMs, signal, async (operationSignal) => {
      const normalized = normalizeObjectKey(key);
      validateReadBound(maxBytes, this.options.maxObjectBytes);
      let body: Readable | undefined;
      const abort = () => body?.destroy(new ObjectStoreError('object_operation_aborted'));
      try {
        const response = await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: this.path(normalized) }),
          { abortSignal: operationSignal },
        );
        if (!(response.Body instanceof Readable)) throw new ObjectStoreError();
        body = response.Body;
        operationSignal.addEventListener('abort', abort, { once: true });
        operationSignal.throwIfAborted();
        if (response.ContentLength !== undefined && response.ContentLength > maxBytes)
          throw new ObjectStoreError('object_too_large');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of body) {
          operationSignal.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new ObjectStoreError();
          size += chunk.byteLength;
          if (size > maxBytes) throw new ObjectStoreError('object_too_large');
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks, size);
      } catch (error) {
        if (statusCode(error) === 404) throw new ObjectNotFoundError();
        throw error;
      } finally {
        operationSignal.removeEventListener('abort', abort);
        body?.destroy();
      }
    });
  }
  async delete(key: ObjectKey, signal?: AbortSignal): Promise<void> {
    return objectOperation(this.options.timeoutMs, signal, async (operationSignal) => {
      const normalized = normalizeObjectKey(key);
      try {
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: this.path(normalized) }),
          { abortSignal: operationSignal },
        );
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }
    });
  }
  destroy(): void {
    this.client.destroy();
  }
  private path(key: ObjectKey): string {
    return `${key.workspaceId}/${key.objectId}`;
  }
}

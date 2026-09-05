import { LocalObjectStore, DEFAULT_LOCAL_OBJECT_PATH } from './local-store.js';
import { S3ObjectStore, normalizeS3Config, type S3ObjectStoreConfig } from './s3-store.js';
import { ObjectStoreError, type ObjectStore } from './store.js';
import type { ObjectStoreOptions } from './operation.js';
export type ObjectStorageConfig =
  { backend: 'local'; rootDirectory: string } | ({ backend: 's3' } & S3ObjectStoreConfig);
export function readObjectStorageConfig(
  env: Record<string, string | undefined> = process.env,
): ObjectStorageConfig {
  const backend = env.OBJECT_STORAGE_BACKEND ?? 'local';
  if (backend === 'local') {
    const rootDirectory = env.OBJECT_STORAGE_LOCAL_PATH ?? DEFAULT_LOCAL_OBJECT_PATH;
    // Validate operator configuration before accepting requests; construction performs no object I/O.
    new LocalObjectStore(rootDirectory);
    return { backend, rootDirectory };
  }
  if (backend !== 's3') throw new ObjectStoreError();
  return {
    backend,
    ...normalizeS3Config({
      bucket: env.OBJECT_STORAGE_S3_BUCKET ?? '',
      region: env.OBJECT_STORAGE_S3_REGION ?? 'us-east-1',
      accessKeyId: env.OBJECT_STORAGE_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY ?? '',
      ...(!env.OBJECT_STORAGE_S3_ENDPOINT ? {} : { endpoint: env.OBJECT_STORAGE_S3_ENDPOINT }),
      ...(!env.OBJECT_STORAGE_S3_SESSION_TOKEN
        ? {}
        : { sessionToken: env.OBJECT_STORAGE_S3_SESSION_TOKEN }),
    }),
  };
}
export function createObjectStore(
  config: ObjectStorageConfig,
  options: ObjectStoreOptions = {},
): ObjectStore {
  return config.backend === 'local'
    ? new LocalObjectStore(config.rootDirectory, options)
    : new S3ObjectStore(config, options);
}

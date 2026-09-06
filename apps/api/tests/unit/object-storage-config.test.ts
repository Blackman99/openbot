import { expect, it } from 'vitest';
import { createObjectStore, readObjectStorageConfig } from '../../src/objects/config.js';
it('selects only operator-configured local or private S3 storage without exposing credentials in identity', () => {
  expect(readObjectStorageConfig({})).toEqual({
    backend: 'local',
    rootDirectory: '/var/lib/openbot/objects',
  });
  const config = readObjectStorageConfig({
    OBJECT_STORAGE_BACKEND: 's3',
    OBJECT_STORAGE_S3_ENDPOINT: 'https://storage.example/',
    OBJECT_STORAGE_S3_BUCKET: 'private-avatars',
    OBJECT_STORAGE_S3_REGION: 'us-east-1',
    OBJECT_STORAGE_S3_ACCESS_KEY_ID: 'operator-access',
    OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: 'operator-secret',
  });
  expect(config).toEqual({
    backend: 's3',
    endpoint: 'https://storage.example',
    bucket: 'private-avatars',
    region: 'us-east-1',
    accessKeyId: 'operator-access',
    secretAccessKey: 'operator-secret',
  });
  const store = createObjectStore(config);
  expect(store.identity).toMatch(/^s3:[a-f0-9]{64}$/u);
  expect(store.identity).not.toMatch(/operator-access|operator-secret/u);
});
it.each([
  { OBJECT_STORAGE_BACKEND: 'public-cdn' },
  { OBJECT_STORAGE_BACKEND: 'local', OBJECT_STORAGE_LOCAL_PATH: '../secret-root' },
  { OBJECT_STORAGE_BACKEND: 's3', OBJECT_STORAGE_S3_BUCKET: 'avatars' },
  {
    OBJECT_STORAGE_BACKEND: 's3',
    OBJECT_STORAGE_S3_ENDPOINT: 'https://user:secret@storage.example',
    OBJECT_STORAGE_S3_BUCKET: 'avatars',
    OBJECT_STORAGE_S3_ACCESS_KEY_ID: 'access',
    OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
  },
])('rejects invalid operator config with a fixed secret-free error', (env) => {
  expect(() => readObjectStorageConfig(env)).toThrow('object_store_unavailable');
});

it('treats empty optional Compose S3 variables as absent', () => {
  expect(
    readObjectStorageConfig({
      OBJECT_STORAGE_BACKEND: 's3',
      OBJECT_STORAGE_S3_BUCKET: 'avatars',
      OBJECT_STORAGE_S3_ACCESS_KEY_ID: 'access',
      OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
      OBJECT_STORAGE_S3_ENDPOINT: '',
      OBJECT_STORAGE_S3_SESSION_TOKEN: '',
    }),
  ).toEqual({
    backend: 's3',
    bucket: 'avatars',
    region: 'us-east-1',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  });
});

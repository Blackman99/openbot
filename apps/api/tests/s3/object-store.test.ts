// Opt-in REAL S3-compatible service gate. Requires a precreated private bucket.
// The deterministic HTTP wire fixture is intentionally not used in this file.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3ObjectStore, type S3ObjectStoreConfig } from '../../src/objects/s3-store.js';
import { createObjectKey } from '../../src/objects/store.js';
import { objectStoreContract } from '../contracts/object-store-contract.js';
const endpoint = process.env.TEST_S3_ENDPOINT;
function config(): S3ObjectStoreConfig {
  const bucket = process.env.TEST_S3_BUCKET;
  const accessKeyId = process.env.TEST_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.TEST_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error('test_s3_configuration_missing');
  return {
    endpoint,
    bucket,
    region: process.env.TEST_S3_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    ...(process.env.TEST_S3_SESSION_TOKEN === undefined
      ? {}
      : { sessionToken: process.env.TEST_S3_SESSION_TOKEN }),
  };
}
describe.skipIf(!endpoint)('private real S3-compatible service acceptance', () => {
  objectStoreContract('real service save/read/immutable replacement/delete', async () => {
    const store = new S3ObjectStore(config(), { maxObjectBytes: 64 });
    return {
      store,
      async dispose() {
        store.destroy();
      },
    };
  });
  // Allow the 3 MiB round trip, byte comparison and cleanup their existing bounded I/O budgets.
  it('keeps attachment and avatar byte bounds independent on the real backend', async () => {
    const store = new S3ObjectStore(config(), { maxObjectBytes: 10485760 });
    const avatar = new S3ObjectStore(config());
    const key = createObjectKey(randomUUID()),
      bytes = Buffer.alloc(3 * 1024 * 1024, 65);
    try {
      await store.save(key, bytes);
      expect(await store.read(key, bytes.length)).toEqual(bytes);
      await expect(avatar.read(key, bytes.length)).rejects.toThrow();
    } finally {
      await store.delete(key);
      store.destroy();
      avatar.destroy();
    }
  }, 30_000);
  it('denies unsigned direct object reads', async () => {
    const configured = config();
    const store = new S3ObjectStore(configured);
    const key = createObjectKey(randomUUID());
    try {
      await store.save(key, Buffer.from('private-acceptance-object'));
      const url = new URL(`${configured.endpoint!.replace(/\/+$/u, '')}/`);
      url.pathname += `${configured.bucket}/${key.workspaceId}/${key.objectId}`;
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {
        throw new Error('unsigned_object_access_check_failed');
      });
      await response.body?.cancel();
      expect([401, 403]).toContain(response.status);
    } finally {
      try {
        await store.delete(key);
      } finally {
        store.destroy();
      }
    }
  });
});

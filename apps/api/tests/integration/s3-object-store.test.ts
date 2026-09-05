import { S3ObjectStore } from '../../src/objects/s3-store.js';
import { objectStoreContract } from '../contracts/object-store-contract.js';
import { s3WireFixture } from '../fixtures/s3-wire.js';
objectStoreContract('S3 adapter against HTTP wire fixture (not a real S3 service)', async () => {
  const fixture = await s3WireFixture();
  const store = new S3ObjectStore(
    {
      endpoint: fixture.endpoint,
      bucket: 'avatars',
      region: 'us-east-1',
      accessKeyId: 'fixture-access',
      secretAccessKey: 'fixture-secret',
    },
    { maxObjectBytes: 64 },
  );
  return {
    store,
    async dispose() {
      store.destroy();
      await fixture.close();
    },
  };
});

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createObjectKey } from '../../src/objects/store.js';
function configured(endpoint: string, timeoutMs = 1_000) {
  return new S3ObjectStore(
    {
      endpoint,
      bucket: 'avatars',
      region: 'us-east-1',
      accessKeyId: 'fixture-access',
      secretAccessKey: 'fixture-secret',
    },
    { maxObjectBytes: 64, timeoutMs },
  );
}
it('sends conditional immutable writes without public ACL grants and bounds chunked object bodies', async () => {
  const fixture = await s3WireFixture();
  const store = configured(fixture.endpoint);
  try {
    const key = createObjectKey(randomUUID());
    await store.save(key, Buffer.from('bytes'));
    expect(fixture.calls[0]).toMatchObject({
      method: 'PUT',
      key: `${key.workspaceId}/${key.objectId}`,
      ifNoneMatch: '*',
      acl: undefined,
    });
    fixture.objects.set(`${key.workspaceId}/${key.objectId}`, Buffer.alloc(65));
    await expect(store.read(key, 64)).rejects.toMatchObject({ code: 'object_too_large' });
    fixture.behavior.chunked = true;
    await expect(store.read(key, 64)).rejects.toMatchObject({ code: 'object_too_large' });
  } finally {
    store.destroy();
    await fixture.close();
  }
});
it('redacts SDK errors and performs no automatic request retries', async () => {
  const fixture = await s3WireFixture();
  const store = configured(fixture.endpoint);
  try {
    fixture.behavior.errorStatus = 503;
    const key = createObjectKey(randomUUID());
    await expect(store.save(key, Buffer.from('bytes'))).rejects.toMatchObject({
      message: 'object_store_unavailable',
    });
    await expect(store.read(key, 64)).rejects.toMatchObject({
      message: 'object_store_unavailable',
    });
    await expect(store.delete(key)).rejects.toMatchObject({ message: 'object_store_unavailable' });
    expect(fixture.calls).toHaveLength(3);
  } finally {
    store.destroy();
    await fixture.close();
  }
});
it.each(['headers', 'body'] as const)(
  'bounds stalled %s under the complete storage deadline',
  async (stall) => {
    const fixture = await s3WireFixture();
    const store = configured(fixture.endpoint, 80);
    try {
      const key = createObjectKey(randomUUID());
      fixture.objects.set(`${key.workspaceId}/${key.objectId}`, Buffer.from('bytes'));
      fixture.behavior.stall = stall;
      await expect(store.read(key, 64)).rejects.toMatchObject({
        message: 'object_store_unavailable',
      });
      expect(fixture.calls.length).toBeLessThanOrEqual(1);
    } finally {
      store.destroy();
      await fixture.close();
    }
  },
);
it('cancels an in-flight object body without exposing the caller abort reason', async () => {
  const fixture = await s3WireFixture();
  const store = configured(fixture.endpoint);
  try {
    const key = createObjectKey(randomUUID());
    fixture.objects.set(`${key.workspaceId}/${key.objectId}`, Buffer.from('bytes'));
    fixture.behavior.stall = 'body';
    const controller = new AbortController();
    const pending = store.read(key, 64, controller.signal);
    const result = expect(pending).rejects.toMatchObject({ message: 'object_operation_aborted' });
    await fixture.bodyStarted;
    controller.abort('secret caller reason');
    await result;
  } finally {
    store.destroy();
    await fixture.close();
  }
});
it('preserves backend identity across credential rotation but distinguishes bucket and endpoint changes', () => {
  const config = {
    endpoint: 'https://storage.example/',
    bucket: 'avatars',
    region: 'us-east-1',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  };
  const original = new S3ObjectStore(config);
  const rotated = new S3ObjectStore({
    ...config,
    endpoint: 'https://storage.example',
    secretAccessKey: 'replacement-secret',
  });
  const other = new S3ObjectStore({ ...config, bucket: 'other-avatars' });
  try {
    expect(original.identity).toBe(rotated.identity);
    expect(original.identity).not.toBe(other.identity);
  } finally {
    original.destroy();
    rotated.destroy();
    other.destroy();
  }
});

it('bounds SDK error-response consumption before deserialization', async () => {
  const fixture = await s3WireFixture();
  const store = configured(fixture.endpoint, 500);
  try {
    fixture.behavior.endlessError = true;
    const error = await store
      .read(createObjectKey(randomUUID()), 64)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: 'object_store_unavailable' });
    expect(error).not.toHaveProperty('$response');
    expect(error).not.toHaveProperty('$metadata');
    expect(fixture.behavior.errorBytesSent).toBeLessThan(1_048_576);
  } finally {
    store.destroy();
    await fixture.close();
  }
});

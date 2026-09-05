import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { S3ObjectStore } from '../../src/objects/s3-store.js';
import { createObjectKey } from '../../src/objects/store.js';
import { s3WireFixture } from '../fixtures/s3-wire.js';
import { classifyS3ErrorForCi, observeS3ForCi } from '../helpers/s3-ci-diagnostics.js';

it('observes an SDK failure without changing its safe store result or exposing the response message', async () => {
  const fixture = await s3WireFixture();
  const diagnostic = observeS3ForCi();
  const store = new S3ObjectStore({
    endpoint: fixture.endpoint,
    bucket: 'avatars',
    region: 'us-east-1',
    accessKeyId: 'fixture-access',
    secretAccessKey: 'fixture-secret',
  });
  try {
    fixture.behavior.errorStatus = 503;
    await expect(store.read(createObjectKey(randomUUID()), 64)).rejects.toMatchObject({
      message: 'object_store_unavailable',
    });
    expect(fixture.calls).toHaveLength(1);
    expect(diagnostic.events).toEqual([
      { operation: 'get', stage: 'send', httpStatus: 503, name: 'AccessDenied', code: 'other' },
    ]);
    expect(JSON.stringify(diagnostic.events)).not.toContain('fixture');
    expect(JSON.stringify(diagnostic.events)).not.toContain('secret');
  } finally {
    diagnostic.restore();
    store.destroy();
    await fixture.close();
  }
});

it('classifies only fixed allowlists and omits unknown error text', () => {
  expect(
    classifyS3ErrorForCi({ name: 'TimeoutError', code: 'ETIMEDOUT', message: 'credential' }),
  ).toEqual({ name: 'TimeoutError', code: 'ETIMEDOUT' });
  expect(
    classifyS3ErrorForCi({
      name: 'secret-name',
      code: 'secret-code',
      message: 'secret-message',
      $response: 'secret-response',
    }),
  ).toEqual({ name: 'other', code: 'other' });
  expect(classifyS3ErrorForCi('secret-string')).toEqual({ name: 'other', code: 'other' });
});

it('observes checksum stream errors without changing validated bytes, propagation, or request count', async () => {
  const fixture = await s3WireFixture();
  const diagnostic = observeS3ForCi();
  const store = new S3ObjectStore({
    endpoint: fixture.endpoint,
    bucket: 'avatars',
    region: 'us-east-1',
    accessKeyId: 'fixture-access',
    secretAccessKey: 'fixture-secret',
  });
  try {
    const key = createObjectKey(randomUUID());
    await store.save(key, Buffer.from('hello'));
    // Independent CRC32 vector for "hello". The second response is deliberately
    // corrupt to verify diagnostics only; this is not a claim about the CI cause.
    fixture.behavior.checksum = 'NhCmhg==';
    expect(await store.read(key, 64)).toEqual(Buffer.from('hello'));
    fixture.behavior.checksum = 'AAAAAA==';
    await expect(store.read(key, 64)).rejects.toMatchObject({
      message: 'object_store_unavailable',
    });
    expect(diagnostic.events).toEqual([
      { operation: 'put', stage: 'send', httpStatus: 200, name: 'none', code: 'none' },
      { operation: 'get', stage: 'send', httpStatus: 200, name: 'none', code: 'none' },
      { operation: 'get', stage: 'send', httpStatus: 200, name: 'none', code: 'none' },
      {
        operation: 'get',
        stage: 'body',
        httpStatus: 200,
        name: 'checksum-mismatch',
        code: 'other',
      },
    ]);
    expect(fixture.calls).toHaveLength(3);
    expect(JSON.stringify(diagnostic.events)).not.toMatch(/hello|NhCmhg|AAAAAA|secret|fixture/u);
  } finally {
    diagnostic.restore();
    store.destroy();
    await fixture.close();
  }
});

import { objectStoreContract } from '../contracts/object-store-contract.js';
objectStoreContract('diagnostics preserve the original wire contract', async () => {
  const fixture = await s3WireFixture();
  const diagnostic = observeS3ForCi();
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
      diagnostic.restore();
      store.destroy();
      await fixture.close();
    },
  };
});

it('caps diagnostic events without suppressing later storage operations', async () => {
  const fixture = await s3WireFixture();
  const diagnostic = observeS3ForCi();
  const store = new S3ObjectStore({
    endpoint: fixture.endpoint,
    bucket: 'avatars',
    region: 'us-east-1',
    accessKeyId: 'fixture-access',
    secretAccessKey: 'fixture-secret',
  });
  try {
    const key = createObjectKey(randomUUID());
    for (let index = 0; index < 68; index++) await store.delete(key);
    expect(diagnostic.events).toHaveLength(64);
    expect(fixture.calls).toHaveLength(68);
    diagnostic.reset();
    expect(diagnostic.events).toHaveLength(0);
    await store.save(key, Buffer.from('bytes'));
    expect(await store.read(key, 64)).toEqual(Buffer.from('bytes'));
    expect(fixture.calls).toHaveLength(70);
  } finally {
    diagnostic.restore();
    store.destroy();
    await fixture.close();
  }
});

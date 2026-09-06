import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createObjectKey,
  ObjectNotFoundError,
  type ObjectStore,
  type ObjectKey,
} from '../../src/objects/store.js';
export interface ObjectStoreFixture {
  store: ObjectStore;
  dispose(): Promise<void>;
}
export function objectStoreContract(name: string, create: () => Promise<ObjectStoreFixture>) {
  describe(name, () => {
    let fixture: ObjectStoreFixture;
    let keys: ObjectKey[];
    const newKey = (workspaceId: string) => {
      const key = createObjectKey(workspaceId);
      keys.push(key);
      return key;
    };
    beforeEach(async () => {
      keys = [];
      fixture = await create();
    });
    afterEach(async () => {
      try {
        if (fixture) for (const key of keys) await fixture.store.delete(key);
      } finally {
        await fixture?.dispose();
      }
    });
    it('saves private bytes and replaces by a fresh key without changing the previous object', async () => {
      const previous = newKey(randomUUID());
      const replacement = newKey(previous.workspaceId);
      expect(replacement.objectId).not.toBe(previous.objectId);
      expect(fixture.store.identity).toMatch(/^(local|s3):[a-f0-9]{64}$/u);
      await fixture.store.save(previous, Buffer.from('old-avatar'));
      await fixture.store.save(replacement, Buffer.from('new-avatar'));
      expect(await fixture.store.read(previous, 64)).toEqual(Buffer.from('old-avatar'));
      expect(await fixture.store.read(replacement, 64)).toEqual(Buffer.from('new-avatar'));
      await fixture.store.delete(replacement);
      await fixture.store.delete(replacement);
      await expect(fixture.store.read(replacement, 64)).rejects.toBeInstanceOf(ObjectNotFoundError);
      expect(await fixture.store.read(previous, 64)).toEqual(Buffer.from('old-avatar'));
    });
    it('rejects overwrite and admits only one concurrent save for the same internal key', async () => {
      const key = newKey(randomUUID());
      const results = await Promise.allSettled([
        fixture.store.save(key, Buffer.from('first')),
        fixture.store.save(key, Buffer.from('second')),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'object_already_exists' },
      });
      const saved = await fixture.store.read(key, 64);
      expect(['first', 'second']).toContain(saved.toString());
      await expect(fixture.store.save(key, Buffer.from('overwrite'))).rejects.toMatchObject({
        code: 'object_already_exists',
      });
      expect(await fixture.store.read(key, 64)).toEqual(saved);
    });
    it('bounds writes and reads independently, including malformed caller bounds', async () => {
      const key = newKey(randomUUID());
      await expect(fixture.store.save(key, Buffer.alloc(65))).rejects.toMatchObject({
        code: 'object_too_large',
      });
      await expect(fixture.store.read(key, 64)).rejects.toBeInstanceOf(ObjectNotFoundError);
      await fixture.store.save(key, Buffer.alloc(40, 7));
      await expect(fixture.store.read(key, 39)).rejects.toMatchObject({ code: 'object_too_large' });
      for (const bound of [0, -1, NaN, Infinity, 1.5, 65])
        await expect(fixture.store.read(key, bound)).rejects.toMatchObject({
          code: 'invalid_object_size',
        });
    });
    it('rejects filenames and traversal and accepts equivalent canonical UUID keys', async () => {
      const key = newKey(randomUUID());
      for (const invalid of [
        { ...key, objectId: '../private' },
        { ...key, workspaceId: '/tmp' },
      ]) {
        await expect(fixture.store.save(invalid, Buffer.from('bytes'))).rejects.toMatchObject({
          code: 'invalid_object_key',
        });
        await expect(fixture.store.read(invalid, 64)).rejects.toMatchObject({
          code: 'invalid_object_key',
        });
        await expect(fixture.store.delete(invalid)).rejects.toMatchObject({
          code: 'invalid_object_key',
        });
      }
      await fixture.store.save(key, Buffer.from('bytes'));
      expect(
        await fixture.store.read(
          { workspaceId: key.workspaceId.toUpperCase(), objectId: key.objectId.toUpperCase() },
          64,
        ),
      ).toEqual(Buffer.from('bytes'));
    });
    it('honors pre-aborted operations without writing or deleting an object', async () => {
      const key = newKey(randomUUID());
      const signal = AbortSignal.abort('private abort reason');
      await expect(fixture.store.save(key, Buffer.from('bytes'), signal)).rejects.toMatchObject({
        message: 'object_operation_aborted',
      });
      await expect(fixture.store.read(key, 64)).rejects.toBeInstanceOf(ObjectNotFoundError);
      await fixture.store.save(key, Buffer.from('bytes'));
      await expect(fixture.store.delete(key, signal)).rejects.toMatchObject({
        message: 'object_operation_aborted',
      });
      await expect(fixture.store.read(key, 64, signal)).rejects.toMatchObject({
        message: 'object_operation_aborted',
      });
      expect(await fixture.store.read(key, 64)).toEqual(Buffer.from('bytes'));
    });
  });
}

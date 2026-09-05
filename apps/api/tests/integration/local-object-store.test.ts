import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { objectStoreContract } from '../contracts/object-store-contract.js';
objectStoreContract('local private object storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-objects-'));
  return {
    store: new LocalObjectStore(root, { maxObjectBytes: 64 }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createObjectKey } from '../../src/objects/store.js';
it('keeps directories and objects private and refuses symlink reads and writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-private-'));
  const outside = await mkdtemp(join(tmpdir(), 'openbot-outside-'));
  try {
    await chmod(root, 0o755);
    const store = new LocalObjectStore(root);
    const key = createObjectKey(randomUUID());
    await store.save(key, Buffer.from('private-bytes'));
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, key.workspaceId))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, key.workspaceId, key.objectId))).mode & 0o777).toBe(0o600);
    const secret = join(outside, 'operator-secret');
    await writeFile(secret, 'outside-secret');
    const linkKey = createObjectKey(key.workspaceId);
    await symlink(secret, join(root, key.workspaceId, linkKey.objectId));
    await expect(store.read(linkKey, 64)).rejects.toMatchObject({
      message: 'object_store_unavailable',
    });
    await expect(store.save(linkKey, Buffer.from('replacement'))).rejects.toMatchObject({
      code: 'object_already_exists',
    });
    await expect(store.delete(linkKey)).rejects.toMatchObject({ code: 'object_store_unavailable' });
    const workspaceLink = createObjectKey(randomUUID());
    await symlink(outside, join(root, workspaceLink.workspaceId));
    await expect(store.save(workspaceLink, Buffer.from('replacement'))).rejects.toMatchObject({
      message: 'object_store_unavailable',
    });
    expect(await readFile(secret, 'utf8')).toBe('outside-secret');
    const rootLink = join(outside, 'root-link');
    await symlink(root, rootLink);
    await expect(new LocalObjectStore(rootLink).read(key, 64)).rejects.toMatchObject({
      code: 'object_store_unavailable',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
it('retains identity across equivalent local roots and rejects untrusted storage paths safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-identity-'));
  try {
    expect(new LocalObjectStore(root).identity).toBe(new LocalObjectStore(`${root}/.`).identity);
    expect(new LocalObjectStore(root).identity).not.toBe(
      new LocalObjectStore(`${root}/other`).identity,
    );
    expect(() => new LocalObjectStore('relative/private-secret')).toThrow(
      'object_store_unavailable',
    );
    const store = new LocalObjectStore(root);
    const key = createObjectKey(randomUUID());
    await mkdir(join(root, key.workspaceId), { mode: 0o700 });
    await mkdir(join(root, key.workspaceId, key.objectId));
    await expect(store.read(key, 64)).rejects.toMatchObject({
      message: 'object_store_unavailable',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

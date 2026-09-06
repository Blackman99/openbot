import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { newProviderDatabase } from '../helpers/provider-database.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { buildApp } from '../../src/app.js';
import { BotAvatarService } from '../../src/bots/avatar-service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const token = Buffer.alloc(32, 21).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };
// A fixed, encoded 1x1 PNG fixture; expected output is independently decoded below.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const pool = new (newProviderDatabase().adapters.createPg().Pool)();
  cleanup.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$avatar-test-only',
    generateSessionToken: () => token,
  });
  const owner = await auth.setup({
    displayName: 'Ada',
    email: 'ada@example.com',
    password: 'correct horse battery staple',
  });
  const botId = randomUUID(),
    versionId = randomUUID();
  const configuration = {
    name: 'Avatar Bot',
    roleDescription: 'Helper',
    description: '',
    instructions: 'Help.',
    modelBinding: {
      scope: { kind: 'personal', id: owner.user.id },
      connectionId: randomUUID(),
      modelId: 'unavailable-model',
    },
    limits: { maxTotalTokens: 32768, maxDurationSeconds: 300, maxTurns: 8, maxDelegationDepth: 2 },
  };
  await pool.query(
    'INSERT INTO bots(id,workspace_id,current_version_id,created_by_user_id,created_at) VALUES($1,$2,$3,$4,NOW())',
    [botId, owner.workspace.id, versionId, owner.user.id],
  );
  await pool.query(
    "INSERT INTO bot_versions(id,bot_id,version,configuration,author_user_id,created_at,rationale) VALUES($1,$2,1,$3::jsonb,$4,NOW(),'Created')",
    [versionId, botId, JSON.stringify(configuration), owner.user.id],
  );
  await pool.query(
    "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'owner',NOW())",
    [botId, owner.user.id],
  );
  const directory = await mkdtemp(join(tmpdir(), 'openbot-avatar-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalObjectStore(directory);
  const avatars = new BotAvatarService(pool, store);
  const app = buildApp({
    auth,
    bots: new BotService(new PostgresBotRepository(pool)),
    avatars,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  return {
    app,
    pool,
    owner,
    botId,
    versionId,
    configuration,
    store,
    avatars,
    path: `/api/v1/workspaces/${owner.workspace.id}/bots/${botId}/avatar`,
  };
}
it('uploads an avatar, appends an immutable version despite unavailable model, and privately reads normalized image bytes', async () => {
  const { app, pool, botId, versionId, configuration, path } = await fixture();
  const response = await app.inject({
    method: 'PUT',
    url: `${path}?expectedCurrentVersionId=${versionId}`,
    headers: { ...headers, 'content-type': 'image/png' },
    payload: png,
  });
  expect(response.statusCode).toBe(200);
  const { version } = response.json();
  expect(version).toMatchObject({
    number: 2,
    rationale: 'Avatar updated',
    configuration: { ...configuration, avatarObjectId: expect.any(String) },
  });
  expect(version.id).not.toBe(versionId);
  expect(
    (await pool.query('SELECT configuration FROM bot_versions WHERE id=$1', [versionId])).rows[0]
      .configuration,
  ).toEqual(configuration);
  expect(
    (await pool.query('SELECT current_version_id FROM bots WHERE id=$1', [botId])).rows,
  ).toEqual([{ current_version_id: version.id }]);
  const read = await app.inject({ url: path, headers });
  expect(read.statusCode).toBe(200);
  expect(read.headers['content-type']).toBe('image/png');
  expect(read.headers['cache-control']).toBe('private, no-store');
  expect(read.headers['x-content-type-options']).toBe('nosniff');
  expect(read.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
it('rejects masquerading image content with a fixed validation error and leaves no intent or version', async () => {
  const { app, pool, versionId, path } = await fixture();
  const response = await app.inject({
    method: 'PUT',
    url: `${path}?expectedCurrentVersionId=${versionId}`,
    headers: { ...headers, 'content-type': 'image/png' },
    payload: Buffer.from('<svg onload="alert(1)"></svg>'),
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: { code: 'invalid_avatar' } });
  expect((await pool.query('SELECT id FROM avatar_objects')).rows).toHaveLength(0);
  expect((await pool.query('SELECT id FROM bot_versions')).rows).toEqual([{ id: versionId }]);
});
it('replaces and removes through CAS while cleanup retains historical images and deletes a failed staged upload', async () => {
  const { app, pool, versionId, path, avatars, store } = await fixture();
  const upload = (expected: string) =>
    app.inject({
      method: 'PUT',
      url: `${path}?expectedCurrentVersionId=${expected}`,
      headers: { ...headers, 'content-type': 'image/png' },
      payload: png,
    });
  const first = (await upload(versionId)).json().version;
  const second = (await upload(first.id)).json().version;
  expect((await upload(first.id)).statusCode).toBe(409);
  const removed = await app.inject({
    method: 'DELETE',
    url: `${path}?expectedCurrentVersionId=${second.id}`,
    headers,
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.json().version).toMatchObject({
    number: 4,
    configuration: { avatarObjectId: null },
  });
  expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
  vi.spyOn(store, 'save').mockRejectedValueOnce(
    new Error('credential-and-provider-response-must-never-leak'),
  );
  const failed = await upload(removed.json().version.id);
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain('credential');
  expect(await avatars.cleanup()).toMatchObject({ retained: 2, deleted: 1 });
  for (const version of [first, second])
    expect((await app.inject({ url: `${path}?versionId=${version.id}`, headers })).statusCode).toBe(
      200,
    );
  expect(
    (await pool.query("SELECT id FROM avatar_objects WHERE state='deleted'")).rows,
  ).toHaveLength(1);
});

it('cancels after object I/O without publishing an orphan and retries failed cleanup idempotently', async () => {
  const { pool, owner, botId, versionId, avatars, store } = await fixture();
  const controller = new AbortController();
  const save = store.save.bind(store);
  vi.spyOn(store, 'save').mockImplementationOnce(async (key, bytes) => {
    await save(key, bytes);
    controller.abort();
  });
  await expect(
    avatars.upload(
      { actorUserId: owner.user.id, workspaceId: owner.workspace.id, botId },
      versionId,
      png,
      'image/png',
      controller.signal,
    ),
  ).rejects.toThrow();
  expect((await pool.query('SELECT id FROM bot_versions')).rows).toEqual([{ id: versionId }]);
  vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('storage credential'));
  expect(await avatars.cleanup()).toEqual({ retained: 0, deleted: 0, retried: 1 });
  expect(await avatars.cleanup()).toEqual({ retained: 0, deleted: 0, retried: 0 });
  await pool.query('UPDATE avatar_objects SET cleanup_after=$1,lease_until=$1', [new Date(0)]);
  expect(await avatars.cleanup()).toEqual({ retained: 0, deleted: 1, retried: 0 });
  expect((await pool.query('SELECT state,attempts FROM avatar_objects')).rows).toEqual([
    { state: 'deleted', attempts: 2 },
  ]);
});

it('requires explicit Bot access even for a workspace owner and keeps discoverable avatar metadata private', async () => {
  const { app, pool, botId, versionId, path, owner } = await fixture();
  const upload = await app.inject({
    method: 'PUT',
    url: `${path}?expectedCurrentVersionId=${versionId}`,
    headers: { ...headers, 'content-type': 'image/png' },
    payload: png,
  });
  const current = upload.json().version;
  const detailPath = path.replace(/\/avatar$/u, '');
  expect((await app.inject({ url: detailPath, headers })).json().bot.avatarVersionId).toBe(
    current.id,
  );
  await pool.query("UPDATE bot_acl SET role='user' WHERE bot_id=$1", [botId]);
  expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `${path}?expectedCurrentVersionId=${current.id}`,
        headers,
      })
    ).statusCode,
  ).toBe(403);
  await pool.query('DELETE FROM bot_acl WHERE bot_id=$1', [botId]);
  expect((await app.inject({ url: path, headers })).statusCode).toBe(403);
  await pool.query("UPDATE bots SET visibility='workspace' WHERE id=$1", [botId]);
  const discover = (await app.inject({ url: detailPath, headers })).json().bot;
  expect(discover).not.toHaveProperty('avatarVersionId');
  expect(discover).not.toHaveProperty('currentVersion');
  expect((await app.inject({ method: 'HEAD', url: path, headers })).statusCode).toBe(403);
  await pool.query(
    "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'editor',NOW())",
    [botId, owner.user.id],
  );
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `${path}?expectedCurrentVersionId=${current.id}`,
        headers,
      })
    ).statusCode,
  ).toBe(200);
});
it('rejects anonymous, cross-origin, oversized, duplicate-precondition and foreign-version reads without publishing changes', async () => {
  const { app, pool, versionId, path } = await fixture();
  expect((await app.inject({ url: path })).statusCode).toBe(401);
  const put = {
    method: 'PUT' as const,
    url: `${path}?expectedCurrentVersionId=${versionId}`,
    headers: { ...headers, 'content-type': 'image/png' },
    payload: png,
  };
  expect(
    (await app.inject({ ...put, headers: { ...put.headers, origin: 'https://evil.example' } }))
      .statusCode,
  ).toBe(403);
  expect((await app.inject({ ...put, payload: Buffer.alloc(2097153) })).statusCode).toBe(413);
  expect(
    (await app.inject({ ...put, url: `${put.url}&expectedCurrentVersionId=${versionId}` }))
      .statusCode,
  ).toBe(400);
  expect((await app.inject({ url: `${path}?versionId=${randomUUID()}`, headers })).statusCode).toBe(
    404,
  );
  expect((await pool.query('SELECT id FROM bot_versions')).rows).toEqual([{ id: versionId }]);
});
it('fails closed when stored bytes are missing, altered or belong to a different configured backend', async () => {
  const { app, pool, store, versionId, path } = await fixture();
  const upload = await app.inject({
    method: 'PUT',
    url: `${path}?expectedCurrentVersionId=${versionId}`,
    headers: { ...headers, 'content-type': 'image/png' },
    payload: png,
  });
  expect(upload.statusCode).toBe(200);
  vi.spyOn(store, 'read').mockResolvedValueOnce(Buffer.from('tampered'));
  expect((await app.inject({ url: path, headers })).statusCode).toBe(503);
  await pool.query("UPDATE avatar_objects SET backend_id='other-private-backend'");
  expect((await app.inject({ url: path, headers })).statusCode).toBe(503);
  await pool.query('UPDATE avatar_objects SET backend_id=$1', [store.identity]);
  const objectId = upload.json().version.configuration.avatarObjectId;
  const row = (await pool.query('SELECT workspace_id FROM avatar_objects WHERE id=$1', [objectId]))
    .rows[0];
  await store.delete({ workspaceId: row.workspace_id, objectId });
  expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
});

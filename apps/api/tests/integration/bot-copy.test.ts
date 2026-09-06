import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { BotCopyApiClient } from '../../../web/src/lib/server/bot-copy-api.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotAvatarService } from '../../src/bots/avatar-service.js';
import { BotVersionService } from '../../src/bots/version-service.js';
import { BotInputError } from '../../src/bots/service.js';
import { appendBotVersion, BotAvatarUnavailableError } from '../../src/bots/append-version.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
import { afterEach, expect, it } from 'vitest';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('previews only reviewable configuration without writes and confirms a new private version one with sole actor ownership', async () => {
  const f = await botAclFixture(cleanup);
  const path = `${f.path}/${f.bot.id}`;
  const before = (await f.pool.query('SELECT * FROM bots')).rows;
  const preview = await f.app.inject({ url: `${path}/copy-preview`, headers: f.headers });
  expect(preview.statusCode).toBe(200);
  expect(preview.headers['cache-control']).toBe('private, no-store');
  expect(preview.headers['x-content-type-options']).toBe('nosniff');
  expect(preview.json()).toMatchObject({
    preview: {
      sourceBotId: f.bot.id,
      sourceVersionId: f.bot.currentVersion.id,
      sourceVersionNumber: 1,
      included: ['identity', 'instructions', 'executionLimits', 'avatarReference', 'modelBinding'],
      excluded: ['credentials', 'acls', 'history', 'memory', 'fileContents', 'audits'],
      configuration: {
        name: 'Private helper',
        instructions: 'Instructions visible only with a direct Bot grant.',
      },
      bindingStatus: { state: 'ready', chatOnly: true },
    },
  });
  expect((await f.pool.query('SELECT * FROM bots')).rows).toEqual(before);
  const confirmed = await f.app.inject({
    method: 'POST',
    url: `${path}/copy`,
    headers: f.headers,
    payload: { expectedCurrentVersionId: f.bot.currentVersion.id },
  });
  expect(confirmed.statusCode).toBe(201);
  const bot = confirmed.json().bot;
  expect(bot.id).not.toBe(f.bot.id);
  expect(bot.currentVersion.id).not.toBe(f.bot.currentVersion.id);
  expect(bot).toMatchObject({
    workspaceId: f.owner.workspace.id,
    visibility: 'private',
    accessRole: 'owner',
    currentVersion: {
      number: 1,
      rationale: 'Copied configuration',
      author: { id: f.owner.user.id },
    },
  });
  expect(bot.currentVersion.configuration).toEqual(preview.json().preview.configuration);
  expect(
    (await f.pool.query('SELECT user_id,role FROM bot_acl WHERE bot_id=$1', [bot.id])).rows,
  ).toEqual([{ user_id: f.owner.user.id, role: 'owner' }]);
  expect(
    (await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='bot.copied'")).rows,
  ).toEqual([
    {
      metadata: {
        workspaceId: f.owner.workspace.id,
        botId: bot.id,
        versionId: bot.currentVersion.id,
        version: 1,
        sourceBotId: f.bot.id,
        sourceVersionId: f.bot.currentVersion.id,
      },
    },
  ]);
  expect(
    JSON.stringify([
      preview.json(),
      confirmed.json(),
      (await f.pool.query('SELECT * FROM bot_versions WHERE bot_id=$1', [bot.id])).rows,
    ]),
  ).not.toMatch(
    /never-return-provider-secret|apiKey|authorization|x-api-key|ciphertext|storageKey/i,
  );
});

it('reuses an authorized avatar reference and preserves copied reads, edits, restore, replacement, removal and cleanup', async () => {
  const f = await botAclFixture(cleanup);
  const directory = await mkdtemp(join(tmpdir(), 'openbot-copy-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalObjectStore(directory),
    avatars = new BotAvatarService(f.pool, store);
  const versions = new BotVersionService(f.pool, avatars);
  const access = {
    actorUserId: f.owner.user.id,
    workspaceId: f.owner.workspace.id,
    botId: f.bot.id,
  };
  const uploaded = await avatars.upload(access, f.bot.currentVersion.id, png, 'image/png');
  const objectId = uploaded.configuration.avatarObjectId!;
  const preview = await f.app.inject({
    url: `${f.path}/${f.bot.id}/copy-preview`,
    headers: f.headers,
  });
  expect(preview.json().preview.configuration.avatarObjectId).toBe(objectId);
  const copy = await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/copy`,
    headers: f.headers,
    payload: { expectedCurrentVersionId: uploaded.id },
  });
  expect(copy.statusCode).toBe(201);
  const bot = copy.json().bot;
  const copied = { ...access, botId: bot.id };
  expect(bot.avatarVersionId).toBe(bot.currentVersion.id);
  expect(bot.currentVersion.configuration.avatarObjectId).toBe(objectId);
  expect((await f.pool.query('SELECT id FROM avatar_objects')).rows).toEqual([{ id: objectId }]);
  expect(await avatars.read(copied, bot.currentVersion.id)).toEqual(
    await avatars.read(access, uploaded.id),
  );
  const edited = await versions.edit(copied, {
    expectedCurrentVersionId: bot.currentVersion.id,
    changes: { name: 'Independent copy' },
  });
  expect(edited.configuration.avatarObjectId).toBe(objectId);
  const replaced = await avatars.upload(copied, edited.id, png, 'image/png');
  expect(replaced.configuration.avatarObjectId).not.toBe(objectId);
  await avatars.remove(access, uploaded.id);
  await avatars.cleanup();
  expect(await avatars.read(copied, bot.currentVersion.id)).toBeInstanceOf(Uint8Array);
  const restored = await versions.restore(copied, {
    expectedCurrentVersionId: replaced.id,
    sourceVersionId: bot.currentVersion.id,
  });
  expect(restored.configuration.avatarObjectId).toBe(objectId);
  const removed = await avatars.remove(copied, restored.id);
  expect(removed.configuration.avatarObjectId).toBeNull();
  await avatars.cleanup();
  expect(await avatars.read(copied, restored.id)).toBeInstanceOf(Uint8Array);
  await expect(
    versions.edit(copied, {
      expectedCurrentVersionId: removed.id,
      changes: { avatarObjectId: objectId },
    }),
  ).rejects.toBeInstanceOf(BotInputError);
  // The new-upload internal path must still refuse an object originating on another Bot.
  const conn = await f.pool.connect();
  try {
    await conn.query('BEGIN');
    await expect(
      appendBotVersion(conn, copied, {
        expectedCurrentVersionId: removed.id,
        changes: { avatarObjectId: objectId },
      }),
    ).rejects.toBeInstanceOf(BotAvatarUnavailableError);
    await conn.query('ROLLBACK');
  } finally {
    conn.release();
  }
});

it('requires current direct user access, chooses a replacement using the actual actor and never copies source ACLs', async () => {
  const f = await botAclFixture(cleanup),
    member = await f.addUser('administrator');
  const path = `${f.path}/${f.bot.id}`;
  await f.pool.query("UPDATE bots SET visibility='workspace' WHERE id=$1", [f.bot.id]);
  for (const suffix of ['/copy-preview', '/copy']) {
    const response = await f.app.inject({
      method: suffix === '/copy' ? 'POST' : 'GET',
      url: `${path}${suffix}`,
      headers: member.headers,
      ...(suffix === '/copy'
        ? { payload: { expectedCurrentVersionId: f.bot.currentVersion.id } }
        : {}),
    });
    expect(response.statusCode).toBe(403);
  }
  await f.pool.query(
    "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'user',NOW())",
    [f.bot.id, member.id],
  );
  const preview = await f.app.inject({ url: `${path}/copy-preview`, headers: member.headers });
  expect(preview.json().preview.bindingStatus).toEqual({
    state: 'unavailable',
    reason: 'not-accessible',
  });
  const denied = await f.app.inject({
    method: 'POST',
    url: `${path}/copy`,
    headers: member.headers,
    payload: { expectedCurrentVersionId: f.bot.currentVersion.id },
  });
  expect(denied.statusCode).toBe(400);
  expect(denied.json()).toEqual({
    error: { code: 'bot_model_unavailable', reason: 'not-accessible' },
  });
  expect((await f.pool.query('SELECT id FROM bots')).rows).toHaveLength(1);
  const replacement = await f.providers.save(member.id, {
    name: 'Replacement',
    baseUrl: 'https://models.example/v1',
    modelId: 'replacement-model',
    apiKey: 'replacement-key-sensitive',
    headers: { 'X-Copy-Private': 'sensitive-header-value' },
  });
  const modelBinding = {
    scope: { kind: 'personal' as const, id: member.id },
    connectionId: replacement.id,
    modelId: replacement.modelId,
  };
  const copied = await f.app.inject({
    method: 'POST',
    url: `${path}/copy`,
    headers: member.headers,
    payload: { expectedCurrentVersionId: f.bot.currentVersion.id, modelBinding },
  });
  expect(copied.statusCode).toBe(201);
  const bot = copied.json().bot;
  expect(bot.currentVersion.configuration.modelBinding).toEqual(modelBinding);
  expect(bot.currentVersion.author.id).toBe(member.id);
  expect(
    (await f.pool.query('SELECT user_id,role FROM bot_acl WHERE bot_id=$1', [bot.id])).rows,
  ).toEqual([{ user_id: member.id, role: 'owner' }]);
  const audits = (await f.pool.query("SELECT * FROM audit_events WHERE event_type='bot.copied'"))
    .rows;
  expect(
    JSON.stringify([
      preview.json(),
      copied.json(),
      audits,
      (await f.pool.query('SELECT * FROM bot_versions WHERE bot_id=$1', [bot.id])).rows,
    ]),
  ).not.toMatch(
    /replacement-key-sensitive|sensitive-header-value|X-Copy-Private|never-return-provider-secret|authorization|ciphertext/i,
  );
  await f.pool.query('DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [f.bot.id, member.id]);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${path}/copy`,
        headers: member.headers,
        payload: { expectedCurrentVersionId: f.bot.currentVersion.id, modelBinding },
      })
    ).statusCode,
  ).toBe(403);
});
it('rejects stale previews, disabled models, malformed input and untrusted origins without creating records', async () => {
  const f = await botAclFixture(cleanup),
    path = `${f.path}/${f.bot.id}`;
  const snapshot = async () =>
    Promise.all(
      [
        'bots',
        'bot_versions',
        'bot_acl',
        'avatar_objects',
        'bot_avatar_references',
        'audit_events',
      ].map(async (table) => (await f.pool.query(`SELECT * FROM ${table}`)).rows),
    );
  const before = await snapshot();
  for (const payload of [
    { expectedCurrentVersionId: '00000000-0000-4000-8000-000000000000' },
    { expectedCurrentVersionId: f.bot.currentVersion.id, avatarObjectId: f.bot.id },
    { expectedCurrentVersionId: f.bot.currentVersion.id, name: 'Forged' },
    { expectedCurrentVersionId: f.bot.currentVersion.id, modelBinding: null },
    { expectedCurrentVersionId: f.bot.currentVersion.id, modelBinding: { apiKey: 'secret' } },
  ])
    expect([400, 409]).toContain(
      (await f.app.inject({ method: 'POST', url: `${path}/copy`, headers: f.headers, payload }))
        .statusCode,
    );
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${path}/copy`,
        headers: { ...f.headers, origin: 'https://untrusted.example' },
        payload: { expectedCurrentVersionId: f.bot.currentVersion.id },
      })
    ).statusCode,
  ).toBe(403);
  expect((await f.app.inject({ url: `${path}/copy-preview` })).statusCode).toBe(401);
  expect(await snapshot()).toEqual(before);
  await f.providers.disable(f.owner.user.id, f.model.id);
  const disabled = await snapshot();
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${path}/copy`,
        headers: f.headers,
        payload: { expectedCurrentVersionId: f.bot.currentVersion.id },
      })
    ).json(),
  ).toEqual({ error: { code: 'bot_model_unavailable', reason: 'disabled' } });
  expect(await snapshot()).toEqual(disabled);
});
it('keeps the actual HTTP preview and copy receipts compatible with the strict BFF client', async () => {
  const f = await botAclFixture(cleanup);
  const api = new BotCopyApiClient(
    async (url, init) => {
      const response = await f.app.inject({
        method: init?.method === 'POST' ? 'POST' : 'GET',
        url: new URL(String(url)).pathname,
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    },
    'http://localhost:3001',
    'http://localhost:3000',
  );
  const session = f.headers.cookie.split('=')[1]!;
  const preview = await api.preview(session, f.owner.workspace.id, f.bot.id);
  expect(preview.status).toBe('available');
  const copy = await api.confirm(session, f.owner.workspace.id, f.bot.id, {
    expectedCurrentVersionId: f.bot.currentVersion.id,
  });
  expect(copy.status).toBe('available');
});

it('does not turn an indirect group grant into direct copy authority', async () => {
  const f = await botAclFixture(cleanup),
    member = await f.addUser();
  const groups = new GroupService(new PostgresGroupRepository(f.pool));
  const group = await groups.create(f.owner.user.id, f.owner.workspace.id, { name: 'Shared work' });
  await groups.addMember(f.owner.user.id, f.owner.workspace.id, group.id, {
    userId: member.id,
    role: 'member',
  });
  const grants = new GroupBotService(new PostgresGroupBotRepository(f.pool));
  await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
    botId: f.bot.id,
    idempotencyKey: 'copy-source-grant',
    history: { mode: 'all' },
  });
  const groupView = await grants.list(member.id, f.owner.workspace.id, group.id);
  expect(groupView.activeCount).toBe(1);
  expect(groupView.grants[0]!.bot.canInspect).toBe(false);
  const path = `${f.path}/${f.bot.id}`;
  expect(
    (await f.app.inject({ url: `${path}/copy-preview`, headers: member.headers })).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${path}/copy`,
        headers: member.headers,
        payload: { expectedCurrentVersionId: f.bot.currentVersion.id },
      })
    ).statusCode,
  ).toBe(403);
  expect((await f.pool.query('SELECT id FROM bots')).rows).toHaveLength(1);
});

it('copies archived configurations into active Bots and refuses deleted sources until owner recovery', async () => {
  const f = await botAclFixture(cleanup),
    path = `${f.path}/${f.bot.id}`;
  expect(
    (await f.app.inject({ method: 'POST', url: `${path}/archive`, headers: f.headers })).statusCode,
  ).toBe(200);
  expect((await f.app.inject({ url: `${path}/copy-preview`, headers: f.headers })).statusCode).toBe(
    200,
  );
  const archivedCopy = await f.app.inject({
    method: 'POST',
    url: `${path}/copy`,
    headers: f.headers,
    payload: { expectedCurrentVersionId: f.bot.currentVersion.id },
  });
  expect(archivedCopy.statusCode).toBe(201);
  expect(archivedCopy.json().bot.lifecycleState).toBe('active');
  expect(
    (await f.app.inject({ method: 'POST', url: `${path}/delete`, headers: f.headers })).statusCode,
  ).toBe(200);
  const member = await f.addUser();
  await f.pool.query(
    "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'user',NOW())",
    [f.bot.id, member.id],
  );
  const before = (await f.pool.query('SELECT id FROM bots')).rows;
  for (const headers of [f.headers, member.headers]) {
    expect((await f.app.inject({ url: `${path}/copy-preview`, headers })).statusCode).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${path}/copy`,
          headers,
          payload: { expectedCurrentVersionId: f.bot.currentVersion.id },
        })
      ).statusCode,
    ).toBe(403);
  }
  expect((await f.pool.query('SELECT id FROM bots')).rows).toEqual(before);
  expect(
    (await f.app.inject({ method: 'POST', url: `${path}/undo-delete`, headers: f.headers }))
      .statusCode,
  ).toBe(200);
  expect((await f.app.inject({ url: `${path}/copy-preview`, headers: f.headers })).statusCode).toBe(
    200,
  );
});

import { BotVersionApiClient } from '../../../web/src/lib/server/bot-version-api.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { BotVersionService } from '../../src/bots/version-service.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newProviderDatabase } from '../helpers/provider-database.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotAvatarService } from '../../src/bots/avatar-service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { buildApp } from '../../src/app.js';
const token = Buffer.alloc(32, 23).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const pool: Pool = new (newProviderDatabase().adapters.createPg().Pool)();
  cleanup.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$version-test',
    generateSessionToken: () => token,
  });
  const owner = await auth.setup({
    displayName: 'Ada',
    email: 'ada@example.com',
    password: 'correct horse battery staple',
  });
  const providers = new ProviderConnections(
    new PostgresProviderRepository(pool),
    new ProviderSecretBox(Buffer.alloc(32, 9).toString('base64')),
    new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
    {
      run: async () => ({
        testedAt: '2030-01-02T00:00:00.000Z',
        text: { ok: true, code: 'passed', raw: 'Text' },
        action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
      }),
    },
  );
  const model = await providers.save(owner.user.id, {
    protocol: 'openai-chat',
    name: 'Basic model',
    baseUrl: 'https://models.example/v1',
    modelId: 'model-one',
    apiKey: 'private-key',
    headers: {},
  });
  const bots = new BotService(new PostgresBotRepository(pool));
  const bot = await bots.create(owner.user.id, owner.workspace.id, {
    name: 'Versioned bot',
    roleDescription: 'Helper',
    description: 'Initial',
    instructions: '  Keep formatting.\n',
    modelBinding: {
      scope: { kind: 'personal', id: owner.user.id },
      connectionId: model.id,
      modelId: model.modelId,
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'openbot-versions-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalObjectStore(directory),
    avatars = new BotAvatarService(pool, store);
  const versions = new BotVersionService(pool, avatars);
  const app = buildApp({
    auth,
    bots,
    avatars,
    botVersions: versions,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  return {
    pool,
    owner,
    providers,
    model,
    bots,
    bot,
    app,
    store,
    avatars,
    versions,
    path: `/api/v1/workspaces/${owner.workspace.id}/bots/${bot.id}`,
    versionId: bot.currentVersion!.id,
  };
}
it('edits configuration atomically and lists immutable author/time/rationale history with field-level comparison', async () => {
  const { app, path, versionId, pool, bot, owner } = await fixture();
  const changed = await app.inject({
    method: 'PATCH',
    url: `${path}/configuration`,
    headers,
    payload: {
      expectedCurrentVersionId: versionId,
      changes: {
        name: 'Revised bot',
        instructions: 'New instructions.\n  Keep indent.',
        limits: { maxTurns: 4 },
      },
      rationale: 'Tighter task scope',
    },
  });
  expect(changed.statusCode).toBe(200);
  const next = changed.json().version;
  expect(next).toMatchObject({
    number: 2,
    rationale: 'Tighter task scope',
    author: { id: owner.user.id, displayName: 'Ada' },
    configuration: {
      name: 'Revised bot',
      instructions: 'New instructions.\n  Keep indent.',
      limits: { ...bot.currentVersion!.configuration.limits, maxTurns: 4 },
    },
  });
  expect(next.id).not.toBe(versionId);
  const list = await app.inject({ url: `${path}/versions`, headers });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toMatchObject({
    currentVersionId: next.id,
    versions: [
      { id: next.id, number: 2, rationale: 'Tighter task scope' },
      { id: versionId, number: 1, rationale: 'Created' },
    ],
    nextBefore: null,
  });
  expect(list.json().versions[0]).not.toHaveProperty('configuration');
  const historical = await app.inject({ url: `${path}/versions/${versionId}`, headers });
  expect(historical.json().version.configuration).toEqual(bot.currentVersion!.configuration);
  const compare = await app.inject({
    url: `${path}/versions/compare?fromVersionId=${versionId}&toVersionId=${next.id}`,
    headers,
  });
  expect(compare.statusCode).toBe(200);
  expect(compare.json()).toEqual({
    fromVersionId: versionId,
    toVersionId: next.id,
    differences: [
      { field: 'name', before: 'Versioned bot', after: 'Revised bot' },
      {
        field: 'instructions',
        before: '  Keep formatting.\n',
        after: 'New instructions.\n  Keep indent.',
      },
      { field: 'limits.maxTurns', before: 8, after: 4 },
    ],
  });
  const audit = (
    await pool.query("SELECT metadata FROM audit_events WHERE event_type='bot.version_created'")
  ).rows;
  expect(audit).toEqual([
    {
      metadata: {
        workspaceId: owner.workspace.id,
        botId: bot.id,
        versionId: next.id,
        previousVersionId: versionId,
        version: 2,
        changedFields: ['name', 'instructions', 'limits.maxTurns'],
      },
    },
  ]);
});
it('restores by appending, applies CAS before preparing a stale restore, and never rewinds history', async () => {
  const { app, path, versionId, pool, bot } = await fixture();
  const edited = (
    await app.inject({
      method: 'PATCH',
      url: `${path}/configuration`,
      headers,
      payload: { expectedCurrentVersionId: versionId, changes: { name: 'Second' } },
    })
  ).json().version;
  const stale = await app.inject({
    method: 'POST',
    url: `${path}/versions/restore`,
    headers,
    payload: {
      expectedCurrentVersionId: versionId,
      sourceVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toEqual({ error: { code: 'bot_version_conflict' } });
  const restored = await app.inject({
    method: 'POST',
    url: `${path}/versions/restore`,
    headers,
    payload: { expectedCurrentVersionId: edited.id, sourceVersionId: versionId },
  });
  expect(restored.statusCode).toBe(200);
  const version3 = restored.json().version;
  expect(version3).toMatchObject({
    number: 3,
    rationale: 'Restored version 1',
    configuration: bot.currentVersion!.configuration,
  });
  expect(version3.id).not.toBe(versionId);
  const identical = await app.inject({
    method: 'POST',
    url: `${path}/versions/restore`,
    headers,
    payload: { expectedCurrentVersionId: version3.id, sourceVersionId: versionId },
  });
  expect(identical.json().version.number).toBe(4);
  const audits = (
    await pool.query(
      "SELECT metadata FROM audit_events WHERE event_type='bot.version_created' ORDER BY occurred_at",
    )
  ).rows;
  expect(audits.at(-1)?.metadata).toMatchObject({
    restoredFromVersionId: versionId,
    changedFields: [],
  });
  expect(
    (
      await pool.query<{ id: string; version: number }>(
        'SELECT id,version FROM bot_versions ORDER BY version',
      )
    ).rows.map(({ version }) => version),
  ).toEqual([1, 2, 3, 4]);
});
it('permits unrelated edits with an unavailable binding but revalidates explicit bindings and every restore', async () => {
  const { app, path, versionId, pool, bot, model, providers, owner } = await fixture();
  await providers.disable(owner.user.id, model.id);
  const changed = await app.inject({
    method: 'PATCH',
    url: `${path}/configuration`,
    headers,
    payload: { expectedCurrentVersionId: versionId, changes: { description: 'Still editable' } },
  });
  expect(changed.statusCode).toBe(200);
  const expected = changed.json().version.id;
  for (const request of [
    {
      method: 'PATCH' as const,
      url: `${path}/configuration`,
      payload: {
        expectedCurrentVersionId: expected,
        changes: { modelBinding: bot.currentVersion!.configuration.modelBinding },
      },
    },
    {
      method: 'POST' as const,
      url: `${path}/versions/restore`,
      payload: { expectedCurrentVersionId: expected, sourceVersionId: versionId },
    },
  ]) {
    const response = await app.inject({ ...request, headers });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'bot_model_unavailable', reason: 'disabled' },
    });
  }
  expect((await app.inject({ url: `${path}/versions/${versionId}`, headers })).statusCode).toBe(
    200,
  );
  expect((await pool.query('SELECT id FROM bot_versions')).rows).toHaveLength(2);
});

it('validates the public patch and precondition without accepting persisted avatar or audit metadata', async () => {
  const { app, path, versionId, pool } = await fixture();
  const edit = (payload: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `${path}/configuration`,
      payload: JSON.stringify(payload),
      headers: { ...headers, 'content-type': 'application/json' },
    });
  for (const changes of [
    { avatarObjectId: randomUUID() },
    { name: '' },
    { instructions: ' ' },
    { limits: { maxTurns: 0 } },
    { limits: { maxDelegationDepth: 9 } },
    { limits: { unknown: 1 } },
    { modelBinding: {} },
    { author_user_id: randomUUID() },
    null,
  ]) {
    const response = await app.inject({
      method: 'PATCH',
      url: `${path}/configuration`,
      headers,
      payload: { expectedCurrentVersionId: versionId, changes },
    });
    expect(response.statusCode).toBe(400);
  }
  for (const payload of [
    { changes: {} },
    { expectedCurrentVersionId: 'invalid', changes: {} },
    { expectedCurrentVersionId: versionId, changes: {}, rationale: 'x'.repeat(501) },
    { expectedCurrentVersionId: versionId, changes: {}, author: randomUUID() },
  ]) {
    expect((await edit(payload)).statusCode).toBe(400);
  }
  expect((await pool.query('SELECT id FROM bot_versions')).rows).toEqual([{ id: versionId }]);
});
it('checks CAS before no-op and keeps immutable history paginated and strictly same-Bot', async () => {
  const { app, path, versionId, pool, bots, owner, bot } = await fixture();
  const edit = (expected: string, changes: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `${path}/configuration`,
      headers,
      payload: { expectedCurrentVersionId: expected, changes },
    });
  expect((await edit(versionId, {})).json().version.id).toBe(versionId);
  const second = (await edit(versionId, { name: 'Second' })).json().version;
  expect((await edit(versionId, { name: 'Second' })).statusCode).toBe(409);
  const third = (await edit(second.id, { name: 'Third' })).json().version;
  const page = (await app.inject({ url: `${path}/versions?limit=1`, headers })).json();
  expect(page).toMatchObject({
    currentVersionId: third.id,
    versions: [{ id: third.id }],
    nextBefore: 3,
  });
  const next = (
    await app.inject({ url: `${path}/versions?limit=1&before=${page.nextBefore}`, headers })
  ).json();
  expect(next).toMatchObject({ versions: [{ id: second.id }], nextBefore: 2 });
  expect(
    (await app.inject({ url: `${path}/versions?limit=1&before=2`, headers })).json(),
  ).toMatchObject({ versions: [{ id: versionId }], nextBefore: null });
  const { avatarObjectId: _avatar, ...input } = bot.currentVersion!.configuration;
  const other = await bots.create(owner.user.id, owner.workspace.id, input);
  const foreign = other.currentVersion!.id;
  expect((await app.inject({ url: `${path}/versions/${foreign}`, headers })).statusCode).toBe(404);
  expect(
    (
      await app.inject({
        url: `${path}/versions/compare?fromVersionId=${versionId}&toVersionId=${foreign}`,
        headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${path}/versions/restore`,
        headers,
        payload: { expectedCurrentVersionId: third.id, sourceVersionId: foreign },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await pool.query("SELECT id FROM audit_events WHERE event_type='bot.version_created'")).rows,
  ).toHaveLength(2);
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=1&limit=2',
    'before=-1',
    'before=2.5',
    'before=1&before=2',
    'unexpected=1',
  ])
    expect((await app.inject({ url: `${path}/versions?${query}`, headers })).statusCode).toBe(400);
});
it('protects all historical reads and writes with current Bot and workspace access, independently from administration', async () => {
  const { app, path, versionId, pool, bot, owner } = await fixture();
  const readPaths = [
    `${path}/versions`,
    `${path}/versions/${versionId}`,
    `${path}/versions/compare?fromVersionId=${versionId}&toVersionId=${versionId}`,
  ];
  const edit = () =>
    app.inject({
      method: 'PATCH',
      url: `${path}/configuration`,
      headers,
      payload: { expectedCurrentVersionId: versionId, changes: { name: 'Nope' } },
    });
  const restore = () =>
    app.inject({
      method: 'POST',
      url: `${path}/versions/restore`,
      headers,
      payload: { expectedCurrentVersionId: versionId, sourceVersionId: versionId },
    });
  await pool.query("UPDATE bot_acl SET role='user' WHERE bot_id=$1", [bot.id]);
  for (const url of readPaths) expect((await app.inject({ url, headers })).statusCode).toBe(200);
  expect((await edit()).statusCode).toBe(403);
  expect((await restore()).statusCode).toBe(403);
  await pool.query('DELETE FROM bot_acl WHERE bot_id=$1', [bot.id]);
  await pool.query("UPDATE bots SET visibility='workspace' WHERE id=$1", [bot.id]);
  for (const url of readPaths) expect((await app.inject({ url, headers })).statusCode).toBe(403);
  expect((await edit()).statusCode).toBe(403);
  expect((await restore()).statusCode).toBe(403);
  await pool.query(
    "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'editor',NOW())",
    [bot.id, owner.user.id],
  );
  await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
    owner.workspace.id,
    owner.user.id,
  ]);
  for (const url of readPaths) expect((await app.inject({ url, headers })).statusCode).toBe(403);
  expect((await edit()).statusCode).toBe(403);
  expect((await restore()).statusCode).toBe(403);
});
it('restores only the retained same-Bot avatar, carries references through config edits, and rejects missing image bytes', async () => {
  const { app, path, versionId, pool, owner, bot, store, avatars } = await fixture();
  const access = { actorUserId: owner.user.id, workspaceId: owner.workspace.id, botId: bot.id };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
    'base64',
  );
  const uploaded = await avatars.upload(access, versionId, png, 'image/png');
  const edited = (
    await app.inject({
      method: 'PATCH',
      url: `${path}/configuration`,
      headers,
      payload: { expectedCurrentVersionId: uploaded.id, changes: { name: 'Retains avatar' } },
    })
  ).json().version;
  expect(edited.configuration.avatarObjectId).toBe(uploaded.configuration.avatarObjectId);
  expect(
    (
      await pool.query('SELECT version_id FROM bot_avatar_references WHERE object_id=$1', [
        uploaded.configuration.avatarObjectId,
      ])
    ).rows,
  ).toHaveLength(2);
  const removed = await avatars.remove(access, edited.id);
  const restored = await app.inject({
    method: 'POST',
    url: `${path}/versions/restore`,
    headers,
    payload: { expectedCurrentVersionId: removed.id, sourceVersionId: uploaded.id },
  });
  expect(restored.statusCode).toBe(200);
  const current = restored.json().version;
  expect(current.configuration).toEqual(uploaded.configuration);
  expect(await avatars.cleanup()).toMatchObject({ retained: 1, deleted: 0 });
  const image = await avatars.read(access, uploaded.id);
  expect(await avatars.read(access, current.id)).toEqual(image);
  await store.delete({
    workspaceId: owner.workspace.id,
    objectId: uploaded.configuration.avatarObjectId!,
  });
  const failed = await app.inject({
    method: 'POST',
    url: `${path}/versions/restore`,
    headers,
    payload: { expectedCurrentVersionId: current.id, sourceVersionId: uploaded.id },
  });
  expect(failed.statusCode).toBe(409);
  expect(failed.json()).toEqual({ error: { code: 'bot_avatar_unavailable' } });
  expect(
    (await pool.query('SELECT current_version_id FROM bots WHERE id=$1', [bot.id])).rows,
  ).toEqual([{ current_version_id: current.id }]);
});
it('rechecks access after restore image I/O and preserves current state when permission is revoked', async () => {
  const { owner, bot, pool, versions, avatars, store, versionId } = await fixture();
  const access = { actorUserId: owner.user.id, workspaceId: owner.workspace.id, botId: bot.id };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
    'base64',
  );
  const uploaded = await avatars.upload(access, versionId, png, 'image/png');
  const read = store.read.bind(store);
  vi.spyOn(store, 'read').mockImplementationOnce(async (...args) => {
    const bytes = await read(...args);
    await pool.query('DELETE FROM bot_acl WHERE bot_id=$1', [bot.id]);
    return bytes;
  });
  await expect(
    versions.restore(access, {
      expectedCurrentVersionId: uploaded.id,
      sourceVersionId: uploaded.id,
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(
    (await pool.query('SELECT id FROM bot_versions WHERE bot_id=$1', [bot.id])).rows,
  ).toHaveLength(2);
});
it('serves the version contract over real HTTP with canonical IDs, fixed errors and private headers', async () => {
  const { app, path, versionId } = await fixture();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}${path}/configuration`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedCurrentVersionId: versionId.toUpperCase(),
      changes: { description: 'HTTP saved' },
    }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const payload = await response.json();
  expect(typeof payload.version.createdAt).toBe('string');
  const anonymous = await fetch(`${address}${path}/versions`);
  expect(anonymous.status).toBe(401);
  const foreign = await fetch(`${address}${path}/configuration`, {
    method: 'PATCH',
    headers: { ...headers, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toEqual({ error: { code: 'invalid_origin' } });
});
it('requires exact accessible verified model bindings for edits and rechecks historical model availability on restore', async () => {
  const { app, path, versionId, bot, providers, pool, owner, model } = await fixture();
  const unknown = await providers.save(owner.user.id, {
    protocol: 'openai-chat',
    name: 'Unknown',
    baseUrl: 'https://models.example/v1',
    modelId: 'unknown-model',
    apiKey: 'key',
    headers: {},
  });
  await pool.query("UPDATE personal_model_connections SET policy='{}'::jsonb WHERE id=$1", [
    unknown.id,
  ]);
  const binding = bot.currentVersion!.configuration.modelBinding;
  for (const [target, reason] of [
    [{ ...binding, modelId: 'different-model' }, 'binding-changed'],
    [{ ...binding, scope: { kind: 'personal', id: randomUUID() } }, 'not-accessible'],
    [{ ...binding, scope: { kind: 'workspace', id: randomUUID() } }, 'not-accessible'],
    [{ ...binding, connectionId: unknown.id, modelId: unknown.modelId }, 'capability-unavailable'],
  ] as const) {
    const response = await app.inject({
      method: 'PATCH',
      url: `${path}/configuration`,
      headers,
      payload: { expectedCurrentVersionId: versionId, changes: { modelBinding: target } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'bot_model_unavailable', reason } });
  }
  const valid = await providers.save(owner.user.id, {
    protocol: 'openai-chat',
    name: 'Replacement',
    baseUrl: 'https://models.example/v1',
    modelId: 'replacement-model',
    apiKey: 'key',
    headers: {},
  });
  const response = await app.inject({
    method: 'PATCH',
    url: `${path}/configuration`,
    headers,
    payload: {
      expectedCurrentVersionId: versionId,
      changes: { modelBinding: { ...binding, connectionId: valid.id, modelId: valid.modelId } },
    },
  });
  expect(response.statusCode).toBe(200);
  const current = response.json().version;
  expect(current.configuration.modelBinding).toEqual({
    ...binding,
    connectionId: valid.id,
    modelId: valid.modelId,
  });
  await providers.disable(owner.user.id, model.id);
  const restored = await app.inject({
    method: 'POST',
    url: `${path}/versions/restore`,
    headers,
    payload: { expectedCurrentVersionId: current.id, sourceVersionId: versionId },
  });
  expect(restored.statusCode).toBe(400);
  expect(restored.json().error.reason).toBe('disabled');
  expect(
    (await pool.query('SELECT current_version_id FROM bots WHERE id=$1', [bot.id])).rows,
  ).toEqual([{ current_version_id: current.id }]);
});

it('integrates the strict Web client with live version HTTP including no-op edits, model changes, comparison and restore', async () => {
  const { app, owner, bot, versionId } = await fixture();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new BotVersionApiClient(fetch, address, 'http://localhost:3000');
  const current = await client.get(token, owner.workspace.id, bot.id, versionId);
  expect(current.status).toBe('available');
  const edited = await client.edit(token, owner.workspace.id, bot.id, {
    expectedCurrentVersionId: versionId,
    changes: {
      name: 'BFF edit',
      limits: { maxDelegationDepth: 0 },
      modelBinding: bot.currentVersion!.configuration.modelBinding,
    },
    rationale: 'Reviewed',
  });
  expect(edited.status).toBe('available');
  if (edited.status !== 'available') throw new Error('Expected successful edit');
  expect(edited.value.number).toBe(2);
  expect(
    await client.edit(token, owner.workspace.id, bot.id, {
      expectedCurrentVersionId: versionId,
      changes: { name: 'Stale draft' },
    }),
  ).toEqual({ status: 'conflict' });
  const noop = await client.edit(token, owner.workspace.id, bot.id, {
    expectedCurrentVersionId: edited.value.id,
    changes: { name: 'BFF edit' },
  });
  expect(noop).toMatchObject({ status: 'available', value: { id: edited.value.id, number: 2 } });
  const history = await client.list(token, owner.workspace.id, bot.id, { limit: 1 });
  expect(history).toMatchObject({
    status: 'available',
    value: {
      currentVersionId: edited.value.id,
      versions: [{ id: edited.value.id, number: 2 }],
      nextBefore: 2,
    },
  });
  expect(
    await client.compare(token, owner.workspace.id, bot.id, versionId, edited.value.id),
  ).toEqual({
    status: 'available',
    value: {
      fromVersionId: versionId,
      toVersionId: edited.value.id,
      differences: [
        { field: 'name', before: 'Versioned bot', after: 'BFF edit' },
        { field: 'limits.maxDelegationDepth', before: 2, after: 0 },
      ],
    },
  });
  const restored = await client.restore(token, owner.workspace.id, bot.id, {
    expectedCurrentVersionId: edited.value.id,
    sourceVersionId: versionId,
  });
  expect(restored).toMatchObject({
    status: 'available',
    value: {
      number: 3,
      rationale: 'Restored version 1',
      configuration: bot.currentVersion!.configuration,
    },
  });
  expect(await client.list(undefined, owner.workspace.id, bot.id)).toEqual({ status: 'anonymous' });
});

import { afterEach, expect, it } from 'vitest';
import { publicBotFixture } from '../helpers/public-bot-fixture.js';
import { BotVersionApiClient } from '../../../web/src/lib/server/bot-version-api.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('retrieves an existing UI Bot through a read-scoped Bearer token with the same safe configuration', async () => {
  const f = await publicBotFixture(cleanup);
  const ui = await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers });
  const response = await f.publicApp.inject({
    url: `/v1/bots/${f.bot.id}`,
    headers: await f.bearer(['bots:read']),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(ui.json());
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.body).not.toMatch(
    /never-return-provider-secret|token_digest|ciphertext|sealed_credentials/u,
  );
});

it('round-trips UI configuration edits and public updates while rejecting a stale version without overwriting', async () => {
  const f = await publicBotFixture(cleanup);
  const request: typeof fetch = async (url, init) => {
    const response = await f.publicApp.inject({
      method: init?.method === 'PATCH' ? 'PATCH' : 'GET',
      url: new URL(String(url)).pathname,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(response.body, { status: response.statusCode });
  };
  const web = new BotVersionApiClient(request, 'http://api:3001', 'http://localhost:3000');
  const edited = await web.edit(f.headers.cookie.split('=')[1], f.owner.workspace.id, f.bot.id, {
    expectedCurrentVersionId: f.bot.currentVersion.id,
    changes: {
      name: 'UI renamed Bot',
      roleDescription: 'Updated role',
      description: 'Description from the UI',
      instructions: '  UI instructions\n\nkeep spacing ✓',
      limits: {
        maxTotalTokens: 18221,
        maxDurationSeconds: 123,
        maxTurns: 12,
        maxDelegationDepth: 3,
      },
    },
    rationale: 'Edited in the UI',
  });
  expect(edited.status).toBe('available');
  if (edited.status !== 'available') throw new Error('Expected UI edit');
  const headers = await f.bearer(['bots:read', 'bots:write']);
  const fetched = await f.publicApp.inject({ url: `/v1/bots/${f.bot.id}`, headers });
  expect(fetched.json().bot.currentVersion).toEqual(edited.value);
  const updated = await f.publicApp.inject({
    method: 'PATCH',
    url: `/v1/bots/${f.bot.id}`,
    headers,
    payload: {
      expectedCurrentVersionId: edited.value.id,
      changes: { description: 'Description from the public API' },
      rationale: 'External change',
    },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().version).toMatchObject({
    number: 3,
    configuration: {
      ...edited.value.configuration,
      description: 'Description from the public API',
    },
  });
  const stale = await f.publicApp.inject({
    method: 'PATCH',
    url: `/v1/bots/${f.bot.id}`,
    headers,
    payload: { expectedCurrentVersionId: edited.value.id, changes: { name: 'Must not overwrite' } },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toEqual({ error: { code: 'bot_version_conflict' } });
  expect(
    (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers })).json().bot
      .currentVersion,
  ).toEqual(updated.json().version);
});

it('creates a private Bot through write scope and exposes the same version immediately to the UI', async () => {
  const f = await publicBotFixture(cleanup);
  const configuration = {
    name: 'External helper',
    roleDescription: 'Review assistant',
    description: 'Created through /v1',
    instructions: '  Keep whitespace\nSecond instruction 🚀',
    modelBinding: {
      scope: { kind: 'personal', id: f.owner.user.id },
      connectionId: f.model.id,
      modelId: f.model.modelId,
    },
    limits: { maxTotalTokens: 12234, maxDurationSeconds: 221, maxTurns: 7, maxDelegationDepth: 1 },
  };
  const response = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/bots',
    headers: await f.bearer(['bots:write']),
    payload: configuration,
  });
  expect(response.statusCode).toBe(201);
  const bot = response.json().bot;
  expect(bot).toMatchObject({
    visibility: 'private',
    lifecycleState: 'active',
    accessRole: 'owner',
    currentVersion: { number: 1, configuration, author: { id: f.owner.user.id } },
  });
  expect((await f.app.inject({ url: `${f.path}/${bot.id}`, headers: f.headers })).json()).toEqual(
    response.json(),
  );
  expect(
    (await f.pool.query('SELECT user_id,role FROM bot_acl WHERE bot_id=$1', [bot.id])).rows,
  ).toEqual([{ user_id: f.owner.user.id, role: 'owner' }]);
  const denied = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/bots',
    headers: await f.bearer(['bots:read']),
    payload: configuration,
  });
  expect(denied.statusCode).toBe(403);
  expect(denied.json()).toEqual({ error: { code: 'insufficient_scope' } });
  expect((await f.pool.query('SELECT id FROM bots')).rows).toHaveLength(2);
});

it('paginates current visible Bots with an exclusive stable key and excludes soft-deleted identities', async () => {
  const f = await publicBotFixture(cleanup);
  const original = (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers })).json()
    .bot.currentVersion.configuration;
  const ids = [f.bot.id];
  for (const name of ['Second Bot', 'Third Bot']) {
    const created = await f.app.inject({
      method: 'POST',
      url: f.path,
      headers: f.headers,
      payload: { ...original, name },
    });
    ids.push(created.json().bot.id);
  }
  await f.app.inject({ method: 'POST', url: `${f.path}/${ids[1]}/archive`, headers: f.headers });
  await f.app.inject({ method: 'POST', url: `${f.path}/${ids[2]}/delete`, headers: f.headers });
  const headers = await f.bearer(['bots:read']);
  const first = await f.publicApp.inject({ url: '/v1/bots?limit=1', headers });
  expect(first.statusCode).toBe(200);
  const expected = ids.slice(0, 2).sort();
  expect(first.json()).toMatchObject({ bots: [{ id: expected[0] }], nextAfter: expected[0] });
  expect(first.json().bots[0]).not.toHaveProperty('currentVersion');
  const second = await f.publicApp.inject({
    url: `/v1/bots?limit=1&after=${String(first.json().nextAfter).toUpperCase()}`,
    headers,
  });
  expect(second.json()).toMatchObject({ bots: [{ id: expected[1] }], nextAfter: null });
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=2&limit=1',
    'after=invalid',
    'workspaceId=elsewhere',
  ]) {
    const invalid = await f.publicApp.inject({ url: `/v1/bots?${query}`, headers });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: { code: 'invalid_bot_request' } });
  }
});

it('inspects retained versions through read scope using the same descending history and safe historical configuration', async () => {
  const f = await publicBotFixture(cleanup);
  let pointer = f.bot.currentVersion.id;
  for (const name of ['Version two', 'Version three']) {
    const edited = await f.publicApp.inject({
      method: 'PATCH',
      url: `${f.path}/${f.bot.id}/configuration`,
      headers: f.headers,
      payload: { expectedCurrentVersionId: pointer, changes: { name } },
    });
    expect(edited.statusCode).toBe(200);
    pointer = edited.json().version.id;
  }
  const headers = await f.bearer(['bots:read']);
  const history = await f.publicApp.inject({
    url: `/v1/bots/${f.bot.id}/versions?limit=2`,
    headers,
  });
  expect(history.statusCode).toBe(200);
  expect(history.json()).toMatchObject({
    currentVersionId: pointer,
    versions: [{ number: 3 }, { number: 2 }],
    nextBefore: 2,
  });
  expect(history.json().versions.every((version: object) => !('configuration' in version))).toBe(
    true,
  );
  const older = await f.publicApp.inject({
    url: `/v1/bots/${f.bot.id}/versions?limit=2&before=2`,
    headers,
  });
  expect(older.json()).toMatchObject({
    currentVersionId: pointer,
    versions: [{ number: 1, id: f.bot.currentVersion.id }],
    nextBefore: null,
  });
  const historical = await f.publicApp.inject({
    url: `/v1/bots/${f.bot.id}/versions/${f.bot.currentVersion.id}`,
    headers,
  });
  expect(historical.statusCode).toBe(200);
  expect(historical.json().version.configuration.name).toBe('Private helper');
  expect(
    (
      await f.publicApp.inject({ url: `/v1/bots/${f.bot.id}/versions/${f.owner.user.id}`, headers })
    ).json(),
  ).toEqual({ error: { code: 'bot_version_not_found' } });
});

it('archives through the existing owner lifecycle operation with one audit and no new configuration version', async () => {
  const f = await publicBotFixture(cleanup);
  const headers = await f.bearer(['bots:write']);
  const archive = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/bots/${f.bot.id}/archive`,
    headers,
  });
  expect(archive.statusCode).toBe(200);
  expect(archive.json()).toEqual({
    lifecycle: {
      botId: f.bot.id,
      workspaceId: f.owner.workspace.id,
      state: 'archived',
      deletedAt: null,
      recoveryDeadline: null,
      preDeletedState: null,
    },
  });
  expect(
    (
      await f.publicApp.inject({ method: 'POST', url: `/v1/bots/${f.bot.id}/archive`, headers })
    ).json(),
  ).toEqual(archive.json());
  expect(
    (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers })).json().bot,
  ).toMatchObject({
    lifecycleState: 'archived',
    currentVersion: { id: f.bot.currentVersion.id, number: 1 },
  });
  expect(
    (await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='bot.archived'")).rows,
  ).toEqual([
    {
      metadata: {
        workspaceId: f.owner.workspace.id,
        botId: f.bot.id,
        fromState: 'active',
        toState: 'archived',
      },
    },
  ]);
  const editor = await f.addUser();
  await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/acl`,
    headers: f.headers,
    payload: { userId: editor.id, role: 'editor' },
  });
  const denied = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/bots/${f.bot.id}/archive`,
    headers: await f.bearer(['bots:write'], editor.id),
  });
  expect(denied.statusCode).toBe(403);
  expect(denied.json()).toEqual({ error: { code: 'bot_forbidden' } });
  await f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/delete`, headers: f.headers });
  const deleted = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/bots/${f.bot.id}/archive`,
    headers,
  });
  expect(deleted.statusCode).toBe(409);
  expect(deleted.json()).toEqual({ error: { code: 'bot_lifecycle_conflict' } });
});

it('returns fixed public transport errors for malformed, oversized and unsupported bodies without domain writes', async () => {
  const f = await publicBotFixture(cleanup);
  const headers = await f.bearer(['bots:write']);
  for (const [payload, type, status] of [
    ['{provider-secret', 'application/json', 400],
    ['x'.repeat(262145), 'application/json', 413],
    ['<provider>secret</provider>', 'application/xml', 415],
  ] as const) {
    const response = await f.publicApp.inject({
      method: 'POST',
      url: '/v1/bots',
      headers: { ...headers, 'content-type': type },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: { code: 'invalid_bot_request' } });
  }
  const archiveBody = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/bots/${f.bot.id}/archive`,
    headers,
    payload: { state: 'archived' },
  });
  expect(archiveBody.statusCode).toBe(400);
  expect((await f.pool.query('SELECT id FROM bots')).rows).toHaveLength(1);
  expect(
    (await f.pool.query("SELECT id FROM audit_events WHERE event_type='bot.archived'")).rows,
  ).toEqual([]);
});

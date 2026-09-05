import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { publicBotFixture } from '../helpers/public-bot-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('requires Bearer authentication and explicit read/write scopes on every public operation', async () => {
  const f = await publicBotFixture(cleanup);
  const configuration = (
    await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers })
  ).json().bot.currentVersion.configuration;
  const reads = [
    '/v1/bots',
    `/v1/bots/${f.bot.id}`,
    `/v1/bots/${f.bot.id}/versions`,
    `/v1/bots/${f.bot.id}/versions/${f.bot.currentVersion.id}`,
  ];
  for (const url of reads) {
    const cookieOnly = await f.publicApp.inject({ url, headers: f.headers });
    expect(cookieOnly.statusCode).toBe(401);
    expect(cookieOnly.json()).toEqual({ error: { code: 'invalid_api_token' } });
    expect(cookieOnly.headers['www-authenticate']).toBe('Bearer');
    const writeOnly = await f.publicApp.inject({ url, headers: await f.bearer(['bots:write']) });
    expect(writeOnly.statusCode).toBe(403);
    expect(writeOnly.json()).toEqual({ error: { code: 'insufficient_scope' } });
  }
  const headers = await f.bearer(['bots:read']);
  for (const request of [
    { method: 'POST' as const, url: '/v1/bots', payload: configuration },
    {
      method: 'PATCH' as const,
      url: `/v1/bots/${f.bot.id}`,
      payload: {
        expectedCurrentVersionId: f.bot.currentVersion.id,
        changes: { name: 'Forbidden edit' },
      },
    },
    { method: 'POST' as const, url: `/v1/bots/${f.bot.id}/archive` },
  ]) {
    const denied = await f.publicApp.inject({ ...request, headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: { code: 'insufficient_scope' } });
  }
  for (const query of ['token', 'access_token', 'api_key']) {
    const denied = await f.publicApp.inject({ url: `/v1/bots?${query}=forged`, headers });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: { code: 'invalid_api_token' } });
  }
  expect((await f.pool.query('SELECT id FROM bots')).rows).toHaveLength(1);
  expect((await f.pool.query('SELECT id FROM bot_versions')).rows).toHaveLength(1);
});

it('intersects token scopes with current direct Bot ACLs and keeps workspace discovery redacted', async () => {
  const f = await publicBotFixture(cleanup);
  const administrator = await f.addUser('administrator');
  const headers = await f.bearer(['bots:read', 'bots:write'], administrator.id);
  const base = `/v1/bots/${f.bot.id}`;
  expect((await f.publicApp.inject({ url: base, headers })).json()).toEqual({
    error: { code: 'bot_forbidden' },
  });
  expect((await f.publicApp.inject({ url: '/v1/bots', headers })).json()).toEqual({
    bots: [],
    nextAfter: null,
  });
  await f.app.inject({
    method: 'PATCH',
    url: `${f.path}/${f.bot.id}/visibility`,
    headers: f.headers,
    payload: { visibility: 'workspace' },
  });
  const discovered = await f.publicApp.inject({ url: base, headers });
  expect(discovered.statusCode).toBe(200);
  expect(discovered.json()).toEqual(
    (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: administrator.headers })).json(),
  );
  expect(discovered.json().bot).not.toHaveProperty('currentVersion');
  expect(discovered.body).not.toContain(f.model.id);
  for (const url of [`${base}/versions`, `${base}/versions/${f.bot.currentVersion.id}`]) {
    const denied = await f.publicApp.inject({ url, headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: { code: 'bot_forbidden' } });
  }
  await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/acl`,
    headers: f.headers,
    payload: { userId: administrator.id, role: 'user' },
  });
  expect((await f.publicApp.inject({ url: `${base}/versions`, headers })).statusCode).toBe(200);
  const edit = {
    expectedCurrentVersionId: f.bot.currentVersion.id,
    changes: { description: 'Editor description' },
  };
  expect(
    (await f.publicApp.inject({ method: 'PATCH', url: base, headers, payload: edit })).statusCode,
  ).toBe(403);
  expect(
    (await f.publicApp.inject({ method: 'POST', url: `${base}/archive`, headers })).statusCode,
  ).toBe(403);
  await f.app.inject({
    method: 'PATCH',
    url: `${f.path}/${f.bot.id}/acl/${administrator.id}`,
    headers: f.headers,
    payload: { role: 'editor' },
  });
  const edited = await f.publicApp.inject({ method: 'PATCH', url: base, headers, payload: edit });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().version.author.id).toBe(administrator.id);
  expect(edited.json().version.configuration.modelBinding.scope.id).toBe(f.owner.user.id);
  const selectedOwnerModel = await f.publicApp.inject({
    method: 'PATCH',
    url: base,
    headers,
    payload: {
      expectedCurrentVersionId: edited.json().version.id,
      changes: { modelBinding: edited.json().version.configuration.modelBinding },
    },
  });
  expect(selectedOwnerModel.statusCode).toBe(400);
  expect(selectedOwnerModel.json()).toEqual({
    error: { code: 'bot_model_unavailable', reason: 'not-accessible' },
  });
  await f.app.inject({
    method: 'DELETE',
    url: `${f.path}/${f.bot.id}/acl/${administrator.id}`,
    headers: f.headers,
  });
  expect((await f.publicApp.inject({ url: `${base}/versions`, headers })).statusCode).toBe(403);
});

it('binds authority to the persisted token workspace and rejects revoked, expired and deprovisioned identities', async () => {
  const f = await publicBotFixture(cleanup);
  const other = await new WorkspaceService(new PostgresWorkspaceRepository(f.pool)).create(
    f.owner.user.id,
    { name: 'Other workspace' },
  );
  const token = await f.tokens.create(f.owner.user.id, other.id, {
    name: 'Other workspace',
    scopes: ['bots:read', 'bots:write'],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const headers = {
    authorization: `Bearer ${token.secret}`,
    'x-workspace-id': f.owner.workspace.id,
    'x-user-id': f.owner.user.id,
  };
  expect((await f.publicApp.inject({ url: '/v1/bots', headers })).json()).toEqual({
    bots: [],
    nextAfter: null,
  });
  const denied = await f.publicApp.inject({ url: `/v1/bots/${f.bot.id}`, headers });
  expect(denied.statusCode).toBe(403);
  expect(denied.json()).toEqual({ error: { code: 'bot_forbidden' } });
  await f.tokens.revoke(f.owner.user.id, other.id, token.token.id);
  const revoked = await f.publicApp.inject({ url: '/v1/bots', headers });
  expect(revoked.statusCode).toBe(401);
  expect(revoked.json()).toEqual({ error: { code: 'invalid_api_token' } });
  const expired = await f.bearer(['bots:read']);
  await f.pool.query('UPDATE api_tokens SET created_at=$1,expires_at=$2 WHERE workspace_id=$3', [
    new Date(0),
    new Date(1000),
    f.owner.workspace.id,
  ]);
  expect((await f.publicApp.inject({ url: '/v1/bots', headers: expired })).statusCode).toBe(401);
  const member = await f.addUser();
  const removed = await f.bearer(['bots:read'], member.id);
  await f.pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
    f.owner.workspace.id,
    member.id,
  ]);
  expect((await f.publicApp.inject({ url: '/v1/bots', headers: removed })).statusCode).toBe(401);
});

it('rejects identity, storage, secret and lifecycle fields without appending a version or mutation audit', async () => {
  const f = await publicBotFixture(cleanup);
  const headers = await f.bearer(['bots:write']);
  for (const changes of [
    { avatarObjectId: randomUUID() },
    { lifecycleState: 'archived' },
    { ownerUserId: randomUUID() },
    { apiKey: 'private-provider-key' },
    { privateMemory: 'private-memory-sentinel' },
    { encryption: { key: 'private-encryption-sentinel' } },
    { limits: { maxTurns: 0 } },
  ]) {
    const response = await f.publicApp.inject({
      method: 'PATCH',
      url: `/v1/bots/${f.bot.id}`,
      headers,
      payload: { expectedCurrentVersionId: f.bot.currentVersion.id, changes },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_bot_request' } });
  }
  expect((await f.pool.query('SELECT id FROM bot_versions')).rows).toHaveLength(1);
  const audit = await f.pool.query(
    "SELECT metadata FROM audit_events WHERE event_type <> 'api_token.used'",
  );
  expect(JSON.stringify(audit.rows)).not.toMatch(
    /private-provider-key|private-memory-sentinel|private-encryption-sentinel|never-return-provider-secret/u,
  );
});

it('projects current and historical configuration through an allowlist even when storage contains internal fields', async () => {
  const f = await publicBotFixture(cleanup);
  const safe = (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers })).json().bot
    .currentVersion.configuration;
  // Fault injection at the persistence boundary: internal data is never a public DTO.
  await f.pool.query('UPDATE bot_versions SET configuration=$1::jsonb WHERE id=$2', [
    JSON.stringify({
      ...safe,
      privateMemory: 'private-memory-sentinel',
      sealedCredentials: 'private-encryption-sentinel',
      modelBinding: {
        ...safe.modelBinding,
        apiKey: 'private-provider-key',
        headers: { authorization: 'private-header-sentinel' },
        scope: { ...safe.modelBinding.scope, encryptionKey: 'private-scope-sentinel' },
      },
      limits: { ...safe.limits, internalQuotaKey: 'private-quota-sentinel' },
    }),
    f.bot.currentVersion.id,
  ]);
  const headers = await f.bearer(['bots:read']);
  const current = await f.publicApp.inject({ url: `/v1/bots/${f.bot.id}`, headers });
  expect(current.statusCode).toBe(200);
  expect(current.json().bot.currentVersion.configuration).toEqual(safe);
  const historical = await f.publicApp.inject({
    url: `/v1/bots/${f.bot.id}/versions/${f.bot.currentVersion.id}`,
    headers,
  });
  expect(historical.statusCode).toBe(200);
  expect(historical.json().version.configuration).toEqual(safe);
  const history = await f.publicApp.inject({ url: `/v1/bots/${f.bot.id}/versions`, headers });
  const listed = await f.publicApp.inject({ url: '/v1/bots', headers });
  expect(current.body + historical.body + history.body + listed.body).not.toMatch(
    /private-memory-sentinel|private-encryption-sentinel|private-provider-key|private-header-sentinel|private-scope-sentinel|private-quota-sentinel/u,
  );
  expect((await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers })).json()).toEqual(
    current.json(),
  );
});

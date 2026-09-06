import { BotApiClient } from '../../../web/src/lib/server/bot-api.js';
import { BotAccessError, BotService } from '../../src/bots/service.js';
import { lockAuthorizedBot } from '../../src/bots/postgres-bot-access.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newProviderDatabase } from '../helpers/provider-database.js';
import { buildApp } from '../../src/app.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import type { ConnectionProbe } from '../../src/providers/model-probe.js';

const token = Buffer.alloc(32, 17).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };
const modelInput = {
  protocol: 'openai-chat',
  name: 'Basic model',
  baseUrl: 'https://models.example/v1',
  modelId: 'test-model',
  apiKey: 'private-provider-key',
  headers: { 'x-secret': 'private-header' },
};
const basicReport = {
  testedAt: '2030-01-02T00:00:00.000Z',
  text: { ok: true, code: 'passed', raw: 'Text' },
  action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
};

describe('persistent Bot identity', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  async function fixture(
    options: { onBotQuery?: (statement: string) => void; now?: () => Date } = {},
  ) {
    const pool: Pool = new (newProviderDatabase().adapters.createPg().Pool)();
    cleanup.push(() => pool.end());
    await migrateDatabase(pool, { installPostgresGuards: false });
    const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
      hashPassword: async () => '$argon2id$bot-test-only',
      generateSessionToken: () => token,
    });
    const owner = await auth.setup({
      displayName: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });
    const probe = { run: vi.fn<ConnectionProbe['run']>(async () => structuredClone(basicReport)) };
    const providers = new ProviderConnections(
      new PostgresProviderRepository(pool),
      new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      probe,
    );
    const model = await providers.save(owner.user.id, modelInput);
    const botPool: SqlPool = {
      connect: async () => {
        const connection = await pool.connect();
        return {
          query: async (statement, parameters) => {
            options.onBotQuery?.(statement);
            return connection.query(statement, parameters);
          },
          release: () => connection.release(),
        };
      },
    };
    const app = buildApp({
      bots: new BotService(new PostgresBotRepository(botPool, options.now)),
      auth,
      providers,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const input = {
      name: 'Research helper',
      roleDescription: 'Evidence-focused researcher',
      description: 'Checks sources',
      instructions: '  Preserve quotations.\nExplain uncertainty.\n',
      modelBinding: {
        scope: { kind: 'personal' as const, id: owner.user.id },
        connectionId: model.id,
        modelId: model.modelId,
      },
    };
    return {
      pool,
      owner,
      providers,
      probe,
      model,
      app,
      input,
      path: `/api/v1/workspaces/${owner.workspace.id}/bots`,
    };
  }
  async function addUser(
    context: Awaited<ReturnType<typeof fixture>>,
    email: string,
    role = 'member',
  ) {
    const id = randomUUID(),
      session = randomBytes(32).toString('base64url'),
      now = new Date();
    await context.pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$2,$3)',
      [id, email, now],
    );
    await context.pool.query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4)',
      [context.owner.workspace.id, id, role, now],
    );
    await new PostgresAuthRepository(context.pool).createSession({
      userId: id,
      tokenDigest: createHash('sha256').update(session).digest('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3600000),
      auditId: randomUUID(),
    });
    return { id, email, headers: { ...headers, cookie: `openbot_session=${session}` } };
  }
  it('creates a private stable Bot, immutable version 1, sole owner and mandatory audit with default limits', async () => {
    const { app, path, input, owner, pool, probe } = await fixture();
    const response = await app.inject({ method: 'POST', url: path, headers, payload: input });
    expect(response.statusCode).toBe(201);
    const { bot } = response.json();
    expect(bot).toEqual({
      lifecycleState: 'active',
      id: expect.any(String),
      workspaceId: owner.workspace.id,
      visibility: 'private',
      accessRole: 'owner',
      name: input.name,
      roleDescription: input.roleDescription,
      description: input.description,
      bindingStatus: { state: 'ready', chatOnly: true },
      currentVersion: {
        id: expect.any(String),
        number: 1,
        createdAt: expect.any(String),
        author: { id: owner.user.id, displayName: 'Ada' },
        rationale: 'Created',
        configuration: {
          ...input,
          limits: {
            maxTotalTokens: 32768,
            maxDurationSeconds: 300,
            maxTurns: 8,
            maxDelegationDepth: 2,
          },
        },
      },
    });
    expect(
      (await pool.query('SELECT current_version_id FROM bots WHERE id=$1', [bot.id])).rows,
    ).toEqual([{ current_version_id: bot.currentVersion.id }]);
    expect(
      (await pool.query('SELECT user_id,role FROM bot_acl WHERE bot_id=$1', [bot.id])).rows,
    ).toEqual([{ user_id: owner.user.id, role: 'owner' }]);
    expect(
      (
        await pool.query('SELECT bot_id,version,configuration FROM bot_versions WHERE id=$1', [
          bot.currentVersion.id,
        ])
      ).rows,
    ).toEqual([{ bot_id: bot.id, version: 1, configuration: bot.currentVersion.configuration }]);
    expect(
      (
        await pool.query(
          "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='bot.created'",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: owner.user.id,
        metadata: {
          botId: bot.id,
          workspaceId: owner.workspace.id,
          versionId: bot.currentVersion.id,
          version: 1,
        },
      },
    ]);
    expect(probe.run).toHaveBeenCalledTimes(1);
    expect(response.body).not.toMatch(/private-provider-key|private-header|sealed|baseUrl|apiKey/u);
  });
  it('validates bounded identity and integer limits without storing unknown fields or changing instruction formatting', async () => {
    const { app, path, input, pool } = await fixture();
    for (const payload of [
      [],
      {},
      { ...input, name: ' ' },
      { ...input, name: 'n'.repeat(101) },
      { ...input, roleDescription: 'r'.repeat(201) },
      { ...input, description: 'd'.repeat(2001) },
      { ...input, description: null },
      { ...input, instructions: ' ' },
      { ...input, instructions: 'i'.repeat(32001) },
      { ...input, visibility: 'workspace' },
      { ...input, retryAfterSeconds: 1 },
      { ...input, retryPolicy: { maxAttemptsPerModel: 2 } },
      { ...input, apiKey: 'must-not-store' },
      { ...input, modelBinding: { ...input.modelBinding, apiKey: 'must-not-store' } },
      { ...input, limits: null },
      { ...input, limits: { maxTurns: 0 } },
      { ...input, limits: { maxTurns: 101 } },
      { ...input, limits: { maxTurns: 1.5 } },
      { ...input, limits: { maxTotalTokens: 1000001 } },
      { ...input, limits: { maxDurationSeconds: 3601 } },
      { ...input, limits: { maxDelegationDepth: -1 } },
      { ...input, limits: { maxDelegationDepth: 9 } },
      { ...input, limits: { maxTurns: '8' } },
      { ...input, limits: { unknown: 8 } },
    ]) {
      const response = await app.inject({ method: 'POST', url: path, headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: 'invalid_bot_request' } });
    }
    expect((await pool.query('SELECT id FROM bots')).rows).toHaveLength(0);
    const accepted = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: {
        ...input,
        name: '  ' + 'n'.repeat(100) + '  ',
        roleDescription: 'r'.repeat(200),
        description: 'd'.repeat(2000),
        instructions: 'i'.repeat(32000),
        limits: {
          maxTotalTokens: 1000000,
          maxDurationSeconds: 3600,
          maxTurns: 100,
          maxDelegationDepth: 0,
        },
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().bot.name).toBe('n'.repeat(100));
    expect(accepted.json().bot.currentVersion.configuration.limits).toEqual({
      maxTotalTokens: 1000000,
      maxDurationSeconds: 3600,
      maxTurns: 100,
      maxDelegationDepth: 0,
    });
    expect(accepted.json().bot.currentVersion.configuration.retryPolicy).toBeUndefined();
  });
  it('persists an explicit retry policy and admitted same-scope fallbacks', async () => {
    const context = await fixture();
    const fallback = await context.providers.save(context.owner.user.id, {
      ...modelInput,
      name: 'Fallback model',
      modelId: 'fallback-model',
    });
    const created = await context.app.inject({
      method: 'POST',
      url: context.path,
      headers,
      payload: {
        ...context.input,
        retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
        fallbackBindings: [
          {
            scope: { kind: 'personal', id: context.owner.user.id },
            connectionId: fallback.id,
            modelId: fallback.modelId,
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().bot.currentVersion.configuration.retryPolicy).toEqual({
      maxAttemptsPerModel: 2,
      maxRunsPerChain: 4,
    });
    expect(created.json().bot.currentVersion.configuration.fallbackBindings).toEqual([
      {
        scope: { kind: 'personal', id: context.owner.user.id },
        connectionId: fallback.id,
        modelId: fallback.modelId,
      },
    ]);
    expect(
      (
        await context.app.inject({
          method: 'POST',
          url: context.path,
          headers,
          payload: {
            ...context.input,
            fallbackBindings: [
              {
                scope: { kind: 'personal', id: context.owner.user.id },
                connectionId: fallback.id,
                modelId: fallback.modelId,
              },
            ],
          },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('binds only currently enabled verified Basic models in the actor personal scope or the Bot workspace', async () => {
    const context = await fixture();
    const { app, path, input, pool, owner, model, providers } = context;
    const peer = await addUser(context, 'peer@example.com');
    const peerModel = await providers.save(peer.id, modelInput);
    const otherWorkspace = randomUUID();
    await pool.query(
      "INSERT INTO workspaces(id,name,description,created_at) VALUES($1,'Other','',NOW())",
      [otherWorkspace],
    );
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'owner',NOW())",
      [otherWorkspace, owner.user.id],
    );
    const otherShared = await providers.inWorkspace(otherWorkspace).save(owner.user.id, modelInput);
    const unknown = await providers.save(owner.user.id, modelInput);
    await pool.query("UPDATE personal_model_connections SET policy='{}'::jsonb WHERE id=$1", [
      unknown.id,
    ]);
    const cases = [
      { binding: { ...input.modelBinding, connectionId: randomUUID() }, reason: 'not-accessible' },
      {
        binding: {
          ...input.modelBinding,
          scope: { kind: 'personal', id: peer.id },
          connectionId: peerModel.id,
        },
        reason: 'not-accessible',
      },
      {
        binding: {
          ...input.modelBinding,
          scope: { kind: 'workspace', id: otherWorkspace },
          connectionId: otherShared.id,
        },
        reason: 'not-accessible',
      },
      { binding: { ...input.modelBinding, modelId: 'changed-model' }, reason: 'binding-changed' },
      {
        binding: { ...input.modelBinding, connectionId: unknown.id },
        reason: 'capability-unavailable',
      },
    ];
    for (const { binding, reason } of cases) {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { ...input, modelBinding: binding },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: 'bot_model_unavailable', reason } });
    }
    await providers.disable(owner.user.id, model.id);
    const disabled = await app.inject({ method: 'POST', url: path, headers, payload: input });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json()).toEqual({
      error: { code: 'bot_model_unavailable', reason: 'disabled' },
    });
    expect((await pool.query('SELECT id FROM bots')).rows).toHaveLength(0);
    const shared = await providers.inWorkspace(owner.workspace.id).save(owner.user.id, modelInput);
    const valid = await app.inject({
      method: 'POST',
      url: path,
      headers: peer.headers,
      payload: {
        ...input,
        modelBinding: {
          scope: { kind: 'workspace', id: owner.workspace.id },
          connectionId: shared.id,
          modelId: shared.modelId,
        },
      },
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().bot.accessRole).toBe('owner');
    expect(valid.json().bot.bindingStatus).toEqual({ state: 'ready', chatOnly: true });
  });
  it('lists and inspects only current workspace and independent Bot grants, without exposing private configuration to discovery viewers', async () => {
    const context = await fixture();
    const { app, path, pool, input, owner } = context;
    const peer = await addUser(context, 'workspace-owner@example.com', 'owner');
    const created = (
      await app.inject({ method: 'POST', url: path, headers, payload: input })
    ).json().bot;
    const detail = await app.inject({ url: `${path}/${created.id}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({ bot: created });
    const listing = await app.inject({ url: path, headers });
    expect(listing.statusCode).toBe(200);
    const { currentVersion: _, ...summary } = created;
    expect(listing.json()).toEqual({ bots: [summary] });
    expect(listing.body).not.toContain('instructions');
    expect((await app.inject({ url: path, headers: peer.headers })).json()).toEqual({ bots: [] });
    expect(
      (await app.inject({ url: `${path}/${created.id}`, headers: peer.headers })).statusCode,
    ).toBe(403);
    await pool.query(
      "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'user',NOW())",
      [created.id, peer.id],
    );
    const peerDetail = (
      await app.inject({ url: `${path}/${created.id}`, headers: peer.headers })
    ).json().bot;
    expect(peerDetail.currentVersion.configuration).toEqual(created.currentVersion.configuration);
    expect(peerDetail.bindingStatus).toEqual({ state: 'unavailable', reason: 'not-accessible' });
    await pool.query("UPDATE bots SET visibility='workspace' WHERE id=$1", [created.id]);
    await pool.query('DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [created.id, peer.id]);
    const discovery = await app.inject({ url: `${path}/${created.id}`, headers: peer.headers });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toEqual({
      bot: {
        ...summary,
        visibility: 'workspace',
        accessRole: null,
        bindingStatus: { state: 'unavailable', reason: 'not-accessible' },
      },
    });
    expect(discovery.body).not.toMatch(
      /instructions|modelBinding|connectionId|currentVersion|private-provider-key/u,
    );
    expect(
      (await app.inject({ url: `/api/v1/workspaces/${randomUUID()}/bots/${created.id}`, headers }))
        .statusCode,
    ).toBe(403);
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
      owner.workspace.id,
      owner.user.id,
    ]);
    expect((await app.inject({ url: '/api/v1/me', headers })).json()).toMatchObject({
      user: { id: owner.user.id },
      workspace: null,
    });
    expect((await app.inject({ url: path, headers })).statusCode).toBe(403);
    expect((await app.inject({ url: `${path}/${created.id}`, headers })).statusCode).toBe(403);
    expect((await app.inject({ url: path })).statusCode).toBe(401);
  });
  it('canonicalizes UUID scope and binding identifiers while rejecting malformed IDs without storage errors', async () => {
    const { app, path, owner, input, pool } = await fixture();
    const uppercasePath = `/api/v1/workspaces/${owner.workspace.id.toUpperCase()}/bots`;
    const response = await app.inject({
      method: 'POST',
      url: uppercasePath,
      headers,
      payload: {
        ...input,
        modelBinding: {
          ...input.modelBinding,
          scope: { kind: 'personal', id: owner.user.id.toUpperCase() },
          connectionId: input.modelBinding.connectionId.toUpperCase(),
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const bot = response.json().bot;
    expect(bot.workspaceId).toBe(owner.workspace.id);
    expect(bot.currentVersion.configuration.modelBinding).toEqual(input.modelBinding);
    expect(
      (await app.inject({ url: `${uppercasePath}/${bot.id.toUpperCase()}`, headers })).json(),
    ).toEqual({ bot });
    expect(
      (await pool.query("SELECT metadata FROM audit_events WHERE event_type='bot.created'")).rows,
    ).toEqual([
      {
        metadata: {
          botId: bot.id,
          workspaceId: owner.workspace.id,
          versionId: bot.currentVersion.id,
          version: 1,
        },
      },
    ]);
    for (const url of ['/api/v1/workspaces/bad-id/bots', `${path}/bad-id`])
      expect((await app.inject({ url, headers })).statusCode).toBe(403);
    for (const modelBinding of [
      { ...input.modelBinding, connectionId: 'bad-id' },
      { ...input.modelBinding, scope: { kind: 'personal', id: 'bad-id' } },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            headers,
            payload: { ...input, modelBinding },
          })
        ).json(),
      ).toEqual({ error: { code: 'invalid_bot_request' } });
  });
  it('uses current independent Bot roles for each permission and restores retained grants only after workspace rejoin', async () => {
    const context = await fixture();
    const { app, path, input, pool, owner } = context;
    const bot = (await app.inject({ method: 'POST', url: path, headers, payload: input })).json()
      .bot;
    const peer = await addUser(context, 'bot-permissions@example.com', 'owner');
    const permissions = [
      'discover',
      'inspect',
      'use',
      'edit',
      'manageAcl',
      'manageLifecycle',
    ] as const;
    async function allowed(actor: string, permission: (typeof permissions)[number]) {
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        const row = await lockAuthorizedBot(
          tx,
          { actorUserId: actor, workspaceId: owner.workspace.id, botId: bot.id },
          permission,
        );
        await tx.query('COMMIT');
        return row.id;
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }
    }
    for (const permission of permissions) {
      await expect(allowed(owner.user.id, permission)).resolves.toBe(bot.id);
      await expect(allowed(peer.id, permission)).rejects.toBeInstanceOf(BotAccessError);
    }
    for (const role of ['editor', 'user'] as const) {
      await pool.query(
        'INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(bot_id,user_id) DO UPDATE SET role=$3',
        [bot.id, peer.id, role, new Date()],
      );
      for (const permission of permissions) {
        const can = ['discover', 'inspect', 'use', ...(role === 'editor' ? ['edit'] : [])].includes(
          permission,
        );
        if (can) await expect(allowed(peer.id, permission)).resolves.toBe(bot.id);
        else await expect(allowed(peer.id, permission)).rejects.toBeInstanceOf(BotAccessError);
      }
    }
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
      owner.workspace.id,
      peer.id,
    ]);
    await expect(allowed(peer.id, 'inspect')).rejects.toBeInstanceOf(BotAccessError);
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'member',$3)",
      [owner.workspace.id, peer.id, new Date()],
    );
    await expect(allowed(peer.id, 'inspect')).resolves.toBe(bot.id);
    await pool.query('DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [bot.id, peer.id]);
    await pool.query("UPDATE bots SET visibility='workspace' WHERE id=$1", [bot.id]);
    await expect(allowed(peer.id, 'discover')).resolves.toBe(bot.id);
    for (const permission of permissions.filter((p) => p !== 'discover'))
      await expect(allowed(peer.id, permission)).rejects.toBeInstanceOf(BotAccessError);
  });
  it('samples creation time after current model admission and uses it consistently for the version and audit', async () => {
    let admitted = false;
    const afterAdmission = new Date('2040-02-03T04:05:06.000Z');
    const now = vi.fn(() => {
      expect(admitted).toBe(true);
      return afterAdmission;
    });
    const { app, path, input, pool } = await fixture({
      onBotQuery: (statement) => {
        if (statement.startsWith('SELECT metadata,revision,policy')) admitted = true;
      },
      now,
    });
    const response = await app.inject({ method: 'POST', url: path, headers, payload: input });
    expect(response.statusCode).toBe(201);
    expect(response.json().bot.currentVersion.createdAt).toBe(afterAdmission.toISOString());
    expect(now).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT occurred_at FROM audit_events WHERE event_type='bot.created'"))
        .rows,
    ).toEqual([{ occurred_at: afterAdmission }]);
  });
  it('returns a safe unavailable response when mandatory storage fails without leaking database details', async () => {
    const { app, path, input } = await fixture({
      onBotQuery: (statement) => {
        if (statement.startsWith('INSERT INTO audit_events'))
          throw new Error('private-provider-key SQL secret storage failure');
      },
    });
    const response = await app.inject({ method: 'POST', url: path, headers, payload: input });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'bot_unavailable' } });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it('refreshes binding status after provider changes without rewriting version 1 or substituting a fallback', async () => {
    const { app, path, input, owner, providers, model, pool, probe } = await fixture();
    const bot = (await app.inject({ method: 'POST', url: path, headers, payload: input })).json()
      .bot;
    const version = bot.currentVersion;
    async function status(expected: unknown) {
      const detail = (await app.inject({ method: 'GET', url: `${path}/${bot.id}`, headers })).json()
        .bot;
      expect(detail.currentVersion).toEqual(version);
      expect(detail.bindingStatus).toEqual(expected);
      expect(
        (await app.inject({ method: 'GET', url: path, headers })).json().bots[0].bindingStatus,
      ).toEqual(expected);
    }
    const fallback = await providers.save(owner.user.id, { ...modelInput, name: 'Fallback' });
    let policy = await providers.capabilities(owner.user.id, model.id);
    await providers.setFallbacks(owner.user.id, model.id, {
      expectedRevision: policy.revision,
      requiredCapability: 'basic',
      connectionIds: [fallback.id],
    });
    await providers.disable(owner.user.id, model.id);
    await status({ state: 'unavailable', reason: 'disabled' });
    await providers.update(owner.user.id, model.id, { apiKey: 'rotated-key' });
    await status({ state: 'ready', chatOnly: true });
    policy = await providers.capabilities(owner.user.id, model.id);
    await providers.override(owner.user.id, model.id, {
      expectedRevision: policy.revision,
      capability: 'toolCalling',
      value: true,
      rationale: 'Verified independently',
    });
    await status({ state: 'ready', chatOnly: false });
    policy = await providers.capabilities(owner.user.id, model.id);
    await providers.override(owner.user.id, model.id, {
      expectedRevision: policy.revision,
      capability: 'streaming',
      value: false,
      rationale: 'Streaming failed',
    });
    await status({ state: 'unavailable', reason: 'capability-unavailable' });
    await providers.update(owner.user.id, model.id, { modelId: 'replacement-model' });
    await status({ state: 'unavailable', reason: 'binding-changed' });
    await providers.delete(owner.user.id, model.id);
    await status({ state: 'unavailable', reason: 'not-accessible' });
    expect(
      (await pool.query('SELECT id FROM bot_versions WHERE bot_id=$1', [bot.id])).rows,
    ).toEqual([{ id: version.id }]);
    expect(probe.run).toHaveBeenCalledTimes(4);
  });
  it('crosses the real HTTP client and Fastify boundary for scoped creation, inspection and safe rejection', async () => {
    const context = await fixture();
    const { app, owner, input, providers, model } = context;
    const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new BotApiClient(fetch, apiOrigin, 'http://localhost:3000');
    const created = await client.create(token, owner.workspace.id.toUpperCase(), input);
    expect(created.status).toBe('available');
    if (created.status !== 'available') throw new Error('Expected a persisted Bot');
    expect(await client.get(token, owner.workspace.id, created.value.id.toUpperCase())).toEqual(
      created,
    );
    expect(await client.list(token, owner.workspace.id)).toMatchObject({
      status: 'available',
      value: [{ id: created.value.id }],
    });
    expect(await client.list('invalid-session', owner.workspace.id)).toEqual({
      status: 'anonymous',
    });
    const peer = await addUser(context, 'bff-private-reader@example.com', 'administrator');
    const peerToken = peer.headers.cookie.slice('openbot_session='.length);
    expect(await client.get(peerToken, owner.workspace.id, created.value.id)).toEqual({
      status: 'forbidden',
    });
    expect(await client.create(token, owner.workspace.id, { ...input, name: '' })).toEqual({
      status: 'invalid',
    });
    await providers.disable(owner.user.id, model.id);
    expect(await client.create(token, owner.workspace.id, input)).toEqual({
      status: 'model-unavailable',
      reason: 'disabled',
    });
    expect(
      await new BotApiClient(fetch, apiOrigin, 'https://hostile.example').create(
        token,
        owner.workspace.id,
        input,
      ),
    ).toEqual({ status: 'forbidden' });
  });
  it('binds the longest supported provider model ID and rejects longer bindings', async () => {
    const { app, path, input, owner, providers } = await fixture();
    const model = await providers.save(owner.user.id, { ...modelInput, modelId: 'm'.repeat(256) });
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: {
        ...input,
        modelBinding: { ...input.modelBinding, connectionId: model.id, modelId: model.modelId },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().bot.currentVersion.configuration.modelBinding.modelId).toBe(
      model.modelId,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers,
          payload: {
            ...input,
            modelBinding: { ...input.modelBinding, modelId: 'm'.repeat(257) },
          },
        })
      ).statusCode,
    ).toBe(400);
  });
});

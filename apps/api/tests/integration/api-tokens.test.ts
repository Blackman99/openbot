import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { ApiTokenApiClient } from '../../../web/src/lib/server/api-token-api.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { WorkspaceService, WorkspaceAccessError } from '../../src/workspaces/service.js';
import { newMemDatabase } from '../helpers/provider-database.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  PostgresAuthRepository,
  type SqlPool,
  type SqlConnection,
} from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { ApiTokenService } from '../../src/api-tokens/service.js';
import { PostgresApiTokenRepository } from '../../src/api-tokens/postgres-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';

const session = Buffer.alloc(32, 7).toString('base64url');
const headers = { cookie: `openbot_session=${session}`, origin: 'http://localhost:3000' };
const now = new Date('2030-01-02T03:04:05.000Z');
const expiresAt = '2030-02-01T03:04:05.000Z';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(logger = false) {
  const database = newMemDatabase();
  const pool = new (database.adapters.createPg().Pool)();
  cleanup.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    clock: () => now,
    hashPassword: async () => '$argon2id$test-only',
    generateSessionToken: () => session,
  });
  const owner = await auth.setup({
    displayName: 'Ada',
    email: 'ada@example.com',
    password: 'correct horse battery staple',
  });
  let tokenNow = now;
  let afterWorkspaceLock: () => Promise<void> | void = () => undefined;
  const tokenPool: SqlPool = {
    connect: async () => {
      const connection: SqlConnection = await pool.connect();
      return {
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          statement: string,
          parameters?: unknown[],
        ) => {
          const result = await connection.query<Row>(statement, parameters);
          if (statement === 'SELECT id FROM workspaces WHERE id = $1 FOR UPDATE')
            await afterWorkspaceLock();
          return result;
        },
        release: () => connection.release(),
      };
    },
  };
  const tokens = new ApiTokenService(new PostgresApiTokenRepository(tokenPool), () => tokenNow);
  const app = buildApp({
    auth,
    logger,
    apiTokens: tokens,
    members: new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(pool)),
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  return {
    app,
    owner,
    pool,
    tokens,
    onTokenLock: (callback: () => Promise<void> | void) => {
      afterWorkspaceLock = callback;
    },
    setTokenTime: (time: Date) => {
      tokenNow = time;
    },
    path: `/api/v1/workspaces/${owner.workspace.id}/api-tokens`,
  };
}
async function addMember({ pool, owner }: Awaited<ReturnType<typeof fixture>>) {
  const userId = randomUUID();
  const sessionToken = Buffer.alloc(32, 8).toString('base64url');
  await pool.query(
    'INSERT INTO users (id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$3,$4)',
    [userId, 'grace@example.com', 'Grace', now],
  );
  await pool.query(
    "INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,'member',$3)",
    [owner.workspace.id, userId, now],
  );
  await new PostgresAuthRepository(pool).createSession({
    userId,
    tokenDigest: createHash('sha256').update(sessionToken).digest('hex'),
    createdAt: now,
    expiresAt: new Date(expiresAt),
    auditId: randomUUID(),
  });
  return { userId, headers: { ...headers, cookie: `openbot_session=${sessionToken}` } };
}
describe('workspace API tokens', () => {
  it('creates a scoped expiring token and stores only its digest and redacted metadata', async () => {
    const { app, owner, pool, path } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: { name: 'Automation', scopes: ['me:read', 'bots:read'], expiresAt },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const created = response.json();
    expect(created.secret).toMatch(/^ob_[A-Za-z0-9_-]{43}$/u);
    expect(created.token).toEqual({
      id: expect.any(String),
      creatorUserId: owner.user.id,
      workspaceId: owner.workspace.id,
      name: 'Automation',
      scopes: ['me:read', 'bots:read'],
      createdAt: now.toISOString(),
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    const stored = (await pool.query('SELECT * FROM api_tokens')).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].token_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(created.secret);
    expect(
      (
        await pool.query(
          "SELECT event_type,actor_user_id,metadata FROM audit_events WHERE event_type = 'api_token.created'",
        )
      ).rows,
    ).toEqual([
      {
        event_type: 'api_token.created',
        actor_user_id: owner.user.id,
        metadata: {
          tokenId: created.token.id,
          workspaceId: owner.workspace.id,
          scopes: ['me:read', 'bots:read'],
        },
      },
    ]);
  });
  it('authenticates only Bearer tokens at public /v1/me, audits use, and reports current creator authority', async () => {
    const { app, owner, pool, path } = await fixture();
    const created = (
      await app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { name: 'Identity', scopes: ['me:read'], expiresAt },
      })
    ).json();
    const result = await app.inject({
      url: '/v1/me',
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      user: owner.user,
      workspace: { ...owner.workspace, role: 'owner' },
      token: { id: created.token.id, scopes: ['me:read'] },
    });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(result.json())).not.toContain(created.secret);
    expect((await pool.query('SELECT last_used_at FROM api_tokens')).rows).toEqual([
      { last_used_at: now },
    ]);
    expect(
      (await pool.query("SELECT metadata FROM audit_events WHERE event_type = 'api_token.used'"))
        .rows,
    ).toEqual([
      {
        metadata: {
          tokenId: created.token.id,
          workspaceId: owner.workspace.id,
          scope: 'me:read',
          outcome: 'allowed',
        },
      },
    ]);
    for (const request of [
      { url: '/v1/me', headers },
      { url: `/v1/me?token=${created.secret}` },
      {
        url: `/v1/me?access_token=${created.secret}`,
        headers: { authorization: `Bearer ${created.secret}` },
      },
      { url: '/v1/me', headers: { authorization: `Bearer ${session}` } },
      { url: '/api/v1/me', headers: { authorization: `Bearer ${created.secret}` } },
    ])
      expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(200);
    await pool.query("UPDATE workspace_memberships SET role = 'member' WHERE user_id = $1", [
      owner.user.id,
    ]);
    expect(
      (
        await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${created.secret}` } })
      ).json().workspace.role,
    ).toBe('member');
  });

  it('lists only redacted metadata and permanently revokes a token with an idempotent security audit', async () => {
    const { app, pool, path } = await fixture();
    const created = (
      await app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { name: 'Automation', scopes: ['me:read'], expiresAt },
      })
    ).json();
    const listed = await app.inject({ url: path, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().tokens).toEqual([created.token]);
    expect(listed.json().availableScopes).toEqual([
      'me:read',
      'bots:read',
      'bots:write',
      'groups:read',
      'groups:write',
      'tasks:read',
      'tasks:write',
      'tasks:approve',
      'events:read',
    ]);
    expect(listed.body).not.toMatch(/secret|digest|ob_/u);
    for (let i = 0; i < 2; i++)
      expect(
        (await app.inject({ method: 'DELETE', url: `${path}/${created.token.id}`, headers }))
          .statusCode,
      ).toBe(204);
    expect(
      (await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${created.secret}` } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ url: path, headers })).json().tokens).toEqual([
      { ...created.token, revokedAt: now.toISOString() },
    ]);
    expect(
      (await pool.query("SELECT metadata FROM audit_events WHERE event_type = 'api_token.revoked'"))
        .rows,
    ).toEqual([
      {
        metadata: {
          tokenId: created.token.id,
          workspaceId: created.token.workspaceId,
          reason: 'creator',
        },
      },
    ]);
    expect(JSON.stringify((await pool.query('SELECT * FROM audit_events')).rows)).not.toContain(
      created.secret,
    );
  });

  it('permanently revokes all creator tokens inside member removal, even when rejoining at the same timestamp', async () => {
    const context = await fixture();
    const { app, owner, pool, path } = context;
    const member = await addMember(context);
    const created = (
      await app.inject({
        method: 'POST',
        url: path,
        headers: member.headers,
        payload: { name: 'Member automation', scopes: ['me:read'], expiresAt },
      })
    ).json();
    const bearer = { authorization: `Bearer ${created.secret}` };
    expect((await app.inject({ url: '/v1/me', headers: bearer })).statusCode).toBe(200);
    const members = new PostgresWorkspaceMemberRepository(pool);
    await members.remove({
      actorUserId: owner.user.id,
      workspaceId: owner.workspace.id,
      targetUserId: member.userId,
      occurredAt: now,
      auditId: randomUUID(),
    });
    expect((await pool.query('SELECT revoked_at FROM api_tokens')).rows).toEqual([
      { revoked_at: now },
    ]);
    expect((await app.inject({ url: '/v1/me', headers: bearer })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/me', headers: member.headers })).statusCode).toBe(200);
    expect((await app.inject({ url: path, headers: member.headers })).statusCode).toBe(403);
    await pool.query(
      "INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,'member',$3)",
      [owner.workspace.id, member.userId, now],
    );
    expect((await app.inject({ url: '/v1/me', headers: bearer })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: path, headers: member.headers })).json().tokens[0].revokedAt,
    ).toBe(now.toISOString());
    expect(
      (
        await pool.query(
          "SELECT actor_user_id,metadata FROM audit_events WHERE event_type = 'api_token.revoked'",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: owner.user.id,
        metadata: {
          tokenId: created.token.id,
          workspaceId: owner.workspace.id,
          reason: 'member_removed',
        },
      },
    ]);
  });

  it('rejects insufficient scope, expiration at the boundary, forged secrets, and orphaned membership', async () => {
    const context = await fixture();
    const { app, pool, path, owner, setTokenTime } = context;
    const created = (
      await app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { name: 'Read bots', scopes: ['bots:read'], expiresAt },
      })
    ).json();
    const before = (await pool.query('SELECT * FROM workspaces')).rows;
    const response = await app.inject({
      url: '/v1/me',
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: 'insufficient_scope' } });
    expect((await pool.query('SELECT * FROM workspaces')).rows).toEqual(before);
    expect((await pool.query('SELECT last_used_at FROM api_tokens')).rows).toEqual([
      { last_used_at: null },
    ]);
    expect(
      (await pool.query("SELECT metadata FROM audit_events WHERE event_type = 'api_token.used'"))
        .rows[0]?.metadata.outcome,
    ).toBe('insufficient_scope');
    const valid = (
      await app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { name: 'Identity', scopes: ['me:read'], expiresAt },
      })
    ).json();
    for (const secret of ['ob_' + 'z'.repeat(43), 'not-a-token', ''])
      expect(
        (await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${secret}` } }))
          .statusCode,
      ).toBe(401);
    setTokenTime(new Date(expiresAt));
    expect(
      (await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${valid.secret}` } }))
        .statusCode,
    ).toBe(401);
    setTokenTime(now);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [owner.user.id]);
    expect(
      (await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${valid.secret}` } }))
        .statusCode,
    ).toBe(401);
  });
  it('isolates token management by creator and workspace and rejects cross-origin and malformed requests', async () => {
    const context = await fixture();
    const { app, owner, pool, path } = context;
    const member = await addMember(context);
    const input = { name: 'Automation', scopes: ['me:read'], expiresAt };
    const created = (
      await app.inject({ method: 'POST', url: path, headers, payload: input })
    ).json();
    expect((await app.inject({ url: path, headers: member.headers })).json().tokens).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${path}/${created.token.id}`,
          headers: member.headers,
        })
      ).statusCode,
    ).toBe(404);
    const foreignWorkspace = randomUUID();
    await pool.query("INSERT INTO workspaces (id,name,created_at) VALUES ($1,'Other',$2)", [
      foreignWorkspace,
      now,
    ]);
    const foreignPath = `/api/v1/workspaces/${foreignWorkspace}/api-tokens`;
    for (const [method, url] of [
      ['GET', path],
      ['POST', path],
      ['DELETE', `${path}/${created.token.id}`],
    ] as const) {
      expect(
        (
          await app.inject({
            method,
            url,
            headers: { origin: headers.origin },
            ...(method === 'POST' ? { payload: input } : {}),
          })
        ).statusCode,
      ).toBe(401);
    }
    for (const [method, url] of [
      ['GET', foreignPath],
      ['POST', foreignPath],
      ['DELETE', `${foreignPath}/${created.token.id}`],
    ] as const) {
      expect(
        (
          await app.inject({
            method,
            url,
            headers,
            ...(method === 'POST' ? { payload: input } : {}),
          })
        ).statusCode,
      ).toBe(403);
    }
    for (const method of ['POST', 'DELETE'] as const)
      expect(
        (
          await app.inject({
            method,
            url: method === 'POST' ? path : `${path}/${created.token.id}`,
            headers: { ...headers, origin: 'https://evil.example' },
            ...(method === 'POST' ? { payload: input } : {}),
          })
        ).statusCode,
      ).toBe(403);
    for (const invalid of [
      null,
      { ...input, name: '' },
      { ...input, scopes: [] },
      { ...input, scopes: ['admin:*'] },
      { ...input, scopes: ['me:read', 'me:read'] },
      { ...input, expiresAt: now.toISOString() },
      { ...input, expiresAt: '2032-01-01' },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            headers: { ...headers, 'content-type': 'application/json' },
            payload: JSON.stringify(invalid),
          })
        ).statusCode,
      ).toBe(400);
    expect((await pool.query('SELECT creator_user_id FROM api_tokens')).rows).toEqual([
      { creator_user_id: owner.user.id },
    ]);
    expect(
      (await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${created.secret}` } }))
        .statusCode,
    ).toBe(200);
  });
  it('never logs token secrets in request headers, creation bodies, or forbidden query parameters', async () => {
    const chunks: string[] = [];
    const output = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    let secret = '';
    try {
      const { app, path } = await fixture(true);
      const created = (
        await app.inject({
          method: 'POST',
          url: path,
          headers,
          payload: { name: 'Automation', scopes: ['me:read'], expiresAt },
        })
      ).json();
      secret = created.secret;
      await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${secret}` } });
      await app.inject({ url: `/v1/me?access_token=${secret}` });
      await app.inject({ url: `/v1/unknown?access_token=${secret}` });
      await app.close();
    } finally {
      output.mockRestore();
    }
    expect(chunks.join('')).toContain('incoming request');
    expect(chunks.join('')).not.toContain(secret);
    expect(chunks.join('')).not.toContain(session);
  });

  it('supports uppercase workspace UUIDs over real HTTP for creation, redacted listing and bodyless revocation', async () => {
    const { app, owner, pool } = await fixture();
    const workspaceId = owner.workspace.id.toUpperCase();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new ApiTokenApiClient(fetch, address, headers.origin);
    const created = await client.create(session, workspaceId, {
      name: 'Real HTTP',
      scopes: ['me:read'],
      expiresAt,
    });
    expect(created.status).toBe('available');
    if (created.status !== 'available') throw new Error('Token creation failed');
    expect(created.value.token.workspaceId).toBe(owner.workspace.id);
    expect(await client.list(session, workspaceId)).toMatchObject({
      status: 'available',
      value: { tokens: [{ id: created.value.token.id, name: 'Real HTTP' }] },
    });
    expect(await client.revoke(session, workspaceId, created.value.token.id.toUpperCase())).toEqual(
      {
        status: 'available',
        value: undefined,
      },
    );
    expect(
      (await pool.query("SELECT metadata FROM audit_events WHERE event_type = 'api_token.revoked'"))
        .rows[0]?.metadata.tokenId,
    ).toBe(created.value.token.id);
    expect(
      (
        await fetch(`${address}/v1/me`, {
          headers: { authorization: `Bearer ${created.value.secret}` },
        })
      ).status,
    ).toBe(401);
  });
  it('passes the current creator to resource permission checks, so a write scope cannot elevate a member', async () => {
    const context = await fixture();
    const { tokens, pool, owner } = context;
    const member = await addMember(context);
    const created = await tokens.create(member.userId, owner.workspace.id, {
      name: 'Writer',
      scopes: ['groups:write'],
      expiresAt,
    });
    const identity = await tokens.authorize(created.secret, 'groups:write');
    expect(identity.workspace.role).toBe('member');
    const workspaces = new WorkspaceService(new PostgresWorkspaceRepository(pool));
    await expect(
      workspaces.update(identity.user.id, identity.workspace.id, { name: 'Escalated' }),
    ).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect((await workspaces.get(owner.user.id, owner.workspace.id)).name).toBe('My Workspace');
  });
  it('rejects a token that expires while public identity waits for workspace lock admission', async () => {
    const { app, pool, path, setTokenTime, onTokenLock } = await fixture();
    const created = (
      await app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: {
          name: 'Short-lived',
          scopes: ['me:read'],
          expiresAt: '2030-01-02T03:04:06.000Z',
        },
      })
    ).json();
    onTokenLock(() => setTokenTime(new Date('2030-01-02T03:04:07.000Z')));
    const response = await app.inject({
      url: '/v1/me',
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(response.statusCode).toBe(401);
    expect((await pool.query('SELECT last_used_at FROM api_tokens')).rows).toEqual([
      { last_used_at: null },
    ]);
    expect(
      (await pool.query("SELECT id FROM audit_events WHERE event_type = 'api_token.used'")).rows,
    ).toEqual([]);
  });

  it('rejects creation if the requested expiration passes while waiting for workspace admission', async () => {
    const { app, pool, path, setTokenTime, onTokenLock } = await fixture();
    onTokenLock(() => setTokenTime(new Date('2030-01-02T03:04:07.000Z')));
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: {
        name: 'Expired in queue',
        scopes: ['me:read'],
        expiresAt: '2030-01-02T03:04:06.000Z',
      },
    });
    expect(response.statusCode).toBe(400);
    expect((await pool.query('SELECT id FROM api_tokens')).rows).toEqual([]);
    expect(
      (await pool.query("SELECT id FROM audit_events WHERE event_type = 'api_token.created'")).rows,
    ).toEqual([]);
  });

  it('records successful creation and use at their fresh workspace admission times', async () => {
    const { app, pool, path, setTokenTime, onTokenLock } = await fixture();
    const createdAt = new Date('2030-01-02T03:04:07.000Z');
    const usedAt = new Date('2030-01-02T03:04:09.000Z');
    onTokenLock(() => setTokenTime(createdAt));
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: { name: 'Queued token', scopes: ['me:read'], expiresAt },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json();
    expect(created.token.createdAt).toBe(createdAt.toISOString());
    onTokenLock(() => setTokenTime(usedAt));
    expect(
      (await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${created.secret}` } }))
        .statusCode,
    ).toBe(200);
    expect((await pool.query('SELECT created_at, last_used_at FROM api_tokens')).rows).toEqual([
      { created_at: createdAt, last_used_at: usedAt },
    ]);
    expect(
      (
        await pool.query(
          "SELECT event_type,occurred_at FROM audit_events WHERE event_type IN ('api_token.created','api_token.used') ORDER BY occurred_at",
        )
      ).rows,
    ).toEqual([
      { event_type: 'api_token.created', occurred_at: createdAt },
      { event_type: 'api_token.used', occurred_at: usedAt },
    ]);
  });
  it('records canonical token workspace references when a member is removed through an uppercase workspace route', async () => {
    const context = await fixture();
    const { app, owner, pool, path } = context;
    const member = await addMember(context);
    const created = await app.inject({
      method: 'POST',
      url: path,
      headers: member.headers,
      payload: { name: 'Member token', scopes: ['me:read'], expiresAt },
    });
    expect(created.statusCode).toBe(201);
    const tokenId = created.json().token.id;
    const persisted = (
      await pool.query('SELECT workspace_id FROM api_tokens WHERE id = $1', [tokenId])
    ).rows[0];
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${owner.workspace.id.toUpperCase()}/members/${member.userId}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await pool.query("SELECT metadata FROM audit_events WHERE event_type = 'api_token.revoked'"))
        .rows,
    ).toEqual([
      { metadata: { tokenId, workspaceId: persisted.workspace_id, reason: 'member_removed' } },
    ]);
  });
});

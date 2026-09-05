import { createHash } from 'node:crypto';

import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

const token = Buffer.alloc(32, 7).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };

describe('workspace boundaries', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function fixture() {
    const database = newDb({ noAstCoverageCheck: true });
    const pool = new (database.adapters.createPg().Pool)();
    cleanup.push(() => pool.end());
    await migrateDatabase(pool, { installPostgresGuards: false });
    const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
      hashPassword: async () => '$argon2id$test-only',
      generateSessionToken: () => token,
    });
    const owner = await auth.setup({
      displayName: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });
    const app = buildApp({
      auth,
      workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    return { app, owner, pool };
  }

  it('creates a workspace with the authenticated user as sole owner and safe audit metadata', async () => {
    const { app, owner, pool } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers,
      payload: {
        name: ' Research ',
        description: 'Internal research details',
        ownerId: 'forged-user',
      },
    });
    expect(response.statusCode).toBe(201);
    const workspace = response.json().workspace;
    expect(workspace).toEqual({
      id: expect.any(String),
      name: 'Research',
      description: 'Internal research details',
      role: 'owner',
    });
    expect(
      (
        await pool.query(
          'SELECT user_id, role FROM workspace_memberships WHERE workspace_id = $1',
          [workspace.id],
        )
      ).rows,
    ).toEqual([{ user_id: owner.user.id, role: 'owner' }]);
    expect(
      (
        await pool.query(
          "SELECT actor_user_id, metadata FROM audit_events WHERE event_type = 'workspace.created'",
        )
      ).rows,
    ).toEqual([{ actor_user_id: owner.user.id, metadata: { workspaceId: workspace.id } }]);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('lists and reads equivalent workspace records only through current membership, including for an instance admin', async () => {
    const { app, pool, owner } = await fixture();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers,
      payload: { name: 'Project', description: 'Ada private content' },
    });
    const otherUser = '00000000-0000-4000-8000-000000000090';
    const otherWorkspace = '00000000-0000-4000-8000-000000000091';
    const otherToken = Buffer.alloc(32, 8).toString('base64url');
    await pool.query(
      'INSERT INTO users (id, email, normalized_email, display_name, created_at) VALUES ($1, $2, $2, $3, NOW())',
      [otherUser, 'grace@example.com', 'Grace'],
    );
    await pool.query(
      'INSERT INTO workspaces (id, name, description, created_at) VALUES ($1, $2, $3, NOW())',
      [otherWorkspace, 'Project', 'Grace private content'],
    );
    await pool.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', NOW())",
      [otherWorkspace, otherUser],
    );
    await pool.query(
      'INSERT INTO sessions (token_digest, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [
        createHash('sha256').update(otherToken).digest('hex'),
        otherUser,
        new Date('2020-01-01'),
        new Date('2099-01-01'),
      ],
    );
    const otherHeaders = { ...headers, cookie: `openbot_session=${otherToken}` };

    const mine = await app.inject({ url: '/api/v1/workspaces', headers });
    expect(mine.statusCode).toBe(200);
    expect(
      mine
        .json()
        .workspaces.map((workspace: { id: string }) => workspace.id)
        .sort(),
    ).toEqual([owner.workspace.id, first.json().workspace.id].sort());
    expect(mine.body).not.toContain('Grace private content');
    const theirs = await app.inject({ url: '/api/v1/workspaces', headers: otherHeaders });
    expect(theirs.json().workspaces).toEqual([
      { id: otherWorkspace, name: 'Project', description: 'Grace private content', role: 'owner' },
    ]);
    for (const [requestHeaders, workspaceId] of [
      [headers, otherWorkspace],
      [otherHeaders, first.json().workspace.id],
    ] as const) {
      const rejected = await app.inject({
        url: `/api/v1/workspaces/${workspaceId}`,
        headers: { ...requestHeaders, 'x-workspace-role': 'owner' },
      });
      expect(rejected.statusCode).toBe(404);
      expect(rejected.body).not.toMatch(/private content/);
      const rejectedWrite = await app.inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${workspaceId}`,
        headers: requestHeaders,
        payload: { name: 'Hacked', description: 'Hacked', role: 'owner' },
      });
      expect(rejectedWrite.statusCode).toBe(404);
    }
    const own = await app.inject({
      url: `/api/v1/workspaces/${first.json().workspace.id}`,
      headers,
    });
    expect(own.json()).toEqual(first.json());
    expect(
      (
        await app.inject({ url: `/api/v1/workspaces/${otherWorkspace}`, headers: otherHeaders })
      ).json().workspace.description,
    ).toBe('Grace private content');
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [
      first.json().workspace.id,
      owner.user.id,
    ]);
    expect(
      (await app.inject({ url: `/api/v1/workspaces/${first.json().workspace.id}`, headers }))
        .statusCode,
    ).toBe(404);
  });

  it('updates material settings only for workspace owners or administrators and audits changed fields without content', async () => {
    const { app, pool, owner } = await fixture();
    const path = `/api/v1/workspaces/${owner.workspace.id}`;
    const payload = { name: 'Secret project name', description: 'Confidential instructions' };
    const changed = await app.inject({ method: 'PATCH', url: path, headers, payload });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().workspace).toEqual({ id: owner.workspace.id, ...payload, role: 'owner' });
    await app.inject({ method: 'PATCH', url: path, headers, payload });
    expect(
      (
        await pool.query(
          "SELECT actor_user_id, metadata FROM audit_events WHERE event_type = 'workspace.settings_changed'",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: owner.user.id,
        metadata: { workspaceId: owner.workspace.id, changedFields: ['name', 'description'] },
      },
    ]);
    for (const role of ['member', null]) {
      if (role)
        await pool.query('UPDATE workspace_memberships SET role = $1 WHERE workspace_id = $2', [
          role,
          owner.workspace.id,
        ]);
      else
        await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [
          owner.workspace.id,
        ]);
      const denied = await app.inject({
        method: 'PATCH',
        url: path,
        headers,
        payload: { name: 'Hacked', description: 'Hacked', role: 'owner' },
      });
      expect([401, 404]).toContain(denied.statusCode);
      expect(
        (
          await pool.query('SELECT name, description FROM workspaces WHERE id = $1', [
            owner.workspace.id,
          ])
        ).rows,
      ).toEqual([payload]);
    }
  });

  it('rejects anonymous, cross-site, malformed and oversized writes without creating records', async () => {
    const { app, pool } = await fixture();
    for (const cookie of [
      undefined,
      'openbot_session=invalid',
      `openbot_session=${token}; openbot_session=${token}`,
    ]) {
      const response = await app.inject({
        url: '/api/v1/workspaces',
        headers: cookie ? { cookie } : {},
      });
      expect(response.statusCode).toBe(401);
    }
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { ...headers, origin: 'https://evil.example' },
      payload: { name: 'New' },
    });
    expect(crossSite.statusCode).toBe(403);
    for (const payload of [
      { name: '' },
      { name: ' '.repeat(3) },
      { name: 'x'.repeat(101) },
      { name: 'X', description: 'x'.repeat(2001) },
      { name: 'X\0' },
      { name: 'X', description: false },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect((await pool.query('SELECT id FROM workspaces')).rows).toHaveLength(1);
    expect((await app.inject({ url: '/api/v1/workspaces/not-a-uuid', headers })).statusCode).toBe(
      404,
    );
  });
});

import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService, type AuthenticatedUser } from '../../src/auth/service.js';
import { InvitationService } from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { MemberApiClient } from '../../../web/src/lib/server/member-api.js';
import { InvitationApiClient } from '../../../web/src/lib/server/invitation-api.js';

const token = Buffer.alloc(32, 7).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };

describe('workspace members and roles', () => {
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
      members: new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(pool)),
      invitations: new InvitationService(
        new PostgresInvitationRepository(pool),
        () => new Date(),
        async () => '$argon2id$test-only',
      ),
      workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    return { app, owner, pool };
  }

  async function inviteMember(
    context: Awaited<ReturnType<typeof fixture>>,
    email: string,
    role: 'member' | 'administrator' = 'member',
  ) {
    const invitation = (
      await context.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${context.owner.workspace.id}/invitations`,
        headers,
        payload: { email, role, expiresInDays: 1 },
      })
    ).json();
    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: { origin: headers.origin },
      payload: {
        token: invitation.token,
        email,
        displayName: email.split('@')[0],
        password: 'correct horse battery staple',
      },
    });
    const user: AuthenticatedUser = accepted.json().user;
    return {
      user,
      headers: { ...headers, cookie: String(accepted.headers['set-cookie']).split(';')[0]! },
      invitationId: invitation.invitation.id,
    };
  }

  it('accepts the Web member client over real HTTP for listing, role changes, and bodyless removal', async () => {
    const context = await fixture();
    const grace = await inviteMember(context, 'grace@example.com');
    const address = await context.app.listen({ port: 0, host: '127.0.0.1' });
    const client = new MemberApiClient(fetch, address, headers.origin);
    const workspaceId = context.owner.workspace.id;
    expect(await client.list(token, workspaceId)).toMatchObject({ status: 'available' });
    expect(
      await client.changeRole(token, workspaceId, grace.user.id, 'administrator'),
    ).toMatchObject({
      status: 'available',
      value: { user: grace.user, role: 'administrator' },
    });
    expect(await client.remove(token, workspaceId, grace.user.id)).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(await client.list(token, workspaceId)).toMatchObject({
      status: 'available',
      value: [{ user: context.owner.user, role: 'owner' }],
    });
    expect(
      (await context.app.inject({ url: '/api/v1/me', headers: grace.headers })).json(),
    ).toMatchObject({
      user: grace.user,
      workspace: null,
    });
  });

  it('accepts the Web invitation client over real HTTP for bodyless revocation', async () => {
    const { app, owner } = await fixture();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new InvitationApiClient(fetch, address, headers.origin);
    const created = await client.create(token, owner.workspace.id, {
      email: 'revoked@example.com',
      role: 'member',
      expiresInDays: 1,
    });
    expect(created.status).toBe('available');
    if (created.status !== 'available') throw new Error('Expected a created invitation');
    expect(await client.revoke(token, owner.workspace.id, created.value.invitation.id)).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(await client.list(token, owner.workspace.id)).toMatchObject({
      status: 'available',
      value: [{ id: created.value.invitation.id, revokedAt: expect.any(String) }],
    });
    expect(
      await client.accept(undefined, {
        token: created.value.token,
        email: 'revoked@example.com',
        displayName: 'Revoked',
        password: 'correct horse battery staple',
      }),
    ).toEqual({ status: 'conflict' });
  });

  it('lists only current workspace members and the invitation that admitted each member', async () => {
    const { app, owner, pool } = await fixture();
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${owner.workspace.id}/invitations`,
        headers,
        payload: { email: 'grace@example.com', role: 'member', expiresInDays: 1 },
      })
    ).json();
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: { origin: headers.origin },
      payload: {
        token: created.token,
        email: 'grace@example.com',
        displayName: 'Grace',
        password: 'correct horse battery staple',
      },
    });
    const grace = accepted.json().user;
    const result = await app.inject({
      url: `/api/v1/workspaces/${owner.workspace.id}/members`,
      headers,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().members).toEqual(
      expect.arrayContaining([
        { user: owner.user, role: 'owner', joinedAt: expect.any(String), invitation: null },
        {
          user: grace,
          role: 'member',
          joinedAt: expect.any(String),
          invitation: {
            id: created.invitation.id,
            invitedBy: { id: owner.user.id, displayName: owner.user.displayName },
          },
        },
      ]),
    );
    expect(result.json().members).toHaveLength(2);
    expect(result.body).not.toContain(created.token);
    expect(
      (
        await pool.query('SELECT invitation_id FROM workspace_memberships WHERE user_id = $1', [
          grace.id,
        ])
      ).rows,
    ).toEqual([{ invitation_id: created.invitation.id }]);
    const other = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload: { name: 'Private' },
      })
    ).json().workspace;
    const graceHeaders = {
      ...headers,
      cookie: String(accepted.headers['set-cookie']).split(';')[0]!,
    };
    expect(
      (await app.inject({ url: `/api/v1/workspaces/${other.id}/members`, headers: graceHeaders }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/v1/workspaces/${owner.workspace.id}/members`,
          headers: graceHeaders,
        })
      ).statusCode,
    ).toBe(200);
  });
  it('changes roles only within current authority and audits each material change', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const grace = await inviteMember(context, 'grace@example.com');
    const path = `/api/v1/workspaces/${owner.workspace.id}/members`;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${path}/${grace.user.id}`,
          headers: grace.headers,
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(403);
    const promoted = await app.inject({
      method: 'PATCH',
      url: `${path}/${grace.user.id}`,
      headers,
      payload: { role: 'administrator' },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().member).toMatchObject({
      user: grace.user,
      role: 'administrator',
      invitation: { id: grace.invitationId },
    });
    for (const [userId, role] of [
      [owner.user.id, 'member'],
      [grace.user.id, 'owner'],
    ])
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `${path}/${userId}`,
            headers: grace.headers,
            payload: { role },
          })
        ).statusCode,
      ).toBe(403);
    const third = await inviteMember(context, 'third@example.com');
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${path}/${third.user.id}`,
          headers: grace.headers,
          payload: { role: 'administrator' },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: 'PATCH',
      url: `${path}/${third.user.id}`,
      headers: grace.headers,
      payload: { role: 'administrator' },
    });
    expect(
      (
        await pool.query(
          "SELECT actor_user_id,metadata FROM audit_events WHERE event_type = 'workspace.member_role_changed' ORDER BY occurred_at",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: owner.user.id,
        metadata: {
          workspaceId: owner.workspace.id,
          targetUserId: grace.user.id,
          fromRole: 'member',
          toRole: 'administrator',
        },
      },
      {
        actor_user_id: grace.user.id,
        metadata: {
          workspaceId: owner.workspace.id,
          targetUserId: third.user.id,
          fromRole: 'member',
          toRole: 'administrator',
        },
      },
    ]);
  });
  it('refuses to demote the last owner but permits a transfer after another owner exists', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const path = `/api/v1/workspaces/${owner.workspace.id}/members`;
    const denied = await app.inject({
      method: 'PATCH',
      url: `${path}/${owner.user.id}`,
      headers,
      payload: { role: 'administrator' },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({ error: { code: 'last_owner_required' } });
    const successor = await inviteMember(context, 'successor@example.com');
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${path}/${successor.user.id}`,
          headers,
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${path}/${owner.user.id}`,
          headers,
          payload: { role: 'administrator' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner'",
          [owner.workspace.id],
        )
      ).rows,
    ).toEqual([{ user_id: successor.user.id }]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${path}/${successor.user.id}`,
          headers,
          payload: { role: 'member' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('removes only memberships, immediately returns workspace 403, and preserves the account and session', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const grace = await inviteMember(context, 'grace@example.com');
    const path = `/api/v1/workspaces/${owner.workspace.id}`;
    expect(
      (await app.inject({ method: 'DELETE', url: `${path}/members/${grace.user.id}`, headers }))
        .statusCode,
    ).toBe(204);
    expect((await app.inject({ url: '/api/v1/me', headers: grace.headers })).json()).toEqual({
      user: grace.user,
      workspace: null,
    });
    for (const suffix of ['', '/members', '/invitations'])
      expect((await app.inject({ url: path + suffix, headers: grace.headers })).statusCode).toBe(
        403,
      );
    expect(
      (await app.inject({ method: 'DELETE', url: `${path}/members/${owner.user.id}`, headers }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'DELETE', url: `${path}/members/${grace.user.id}`, headers }))
        .statusCode,
    ).toBe(404);
    expect((await pool.query('SELECT id FROM users WHERE id = $1', [grace.user.id])).rows).toEqual([
      { id: grace.user.id },
    ]);
    expect(
      (
        await pool.query('SELECT user_id FROM local_credentials WHERE user_id = $1', [
          grace.user.id,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query('SELECT revoked_at FROM sessions WHERE user_id = $1', [grace.user.id]))
        .rows,
    ).toEqual([{ revoked_at: null }]);
    expect(
      (
        await pool.query('SELECT consumed_by_user_id FROM workspace_invitations WHERE id = $1', [
          grace.invitationId,
        ])
      ).rows,
    ).toEqual([{ consumed_by_user_id: grace.user.id }]);
    expect(
      (
        await pool.query(
          "SELECT actor_user_id,metadata FROM audit_events WHERE event_type = 'workspace.member_removed'",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: owner.user.id,
        metadata: { workspaceId: owner.workspace.id, targetUserId: grace.user.id, role: 'member' },
      },
    ]);
  });
  it('re-admits a removed account through a fresh invitation and updates only membership provenance', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const grace = await inviteMember(context, 'grace@example.com');
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${owner.workspace.id}/members/${grace.user.id}`,
      headers,
    });
    const fresh = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${owner.workspace.id}/invitations`,
        headers,
        payload: { email: 'grace@example.com', role: 'administrator', expiresInDays: 1 },
      })
    ).json();
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: grace.headers,
      payload: { token: fresh.token },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().user).toEqual(grace.user);
    const members = (
      await app.inject({ url: `/api/v1/workspaces/${owner.workspace.id}/members`, headers })
    ).json().members;
    expect(
      members.find((member: { user: AuthenticatedUser }) => member.user.id === grace.user.id),
    ).toMatchObject({ role: 'administrator', invitation: { id: fresh.invitation.id } });
    expect((await pool.query('SELECT id FROM users')).rows).toHaveLength(2);
    expect(
      (
        await pool.query('SELECT id FROM workspace_invitations WHERE consumed_by_user_id = $1', [
          grace.user.id,
        ])
      ).rows,
    ).toHaveLength(2);
  });

  it('rejects invalid, anonymous, cross-origin, foreign-workspace, and higher-authority member mutations', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const admin = await inviteMember(context, 'admin@example.com', 'administrator');
    const member = await inviteMember(context, 'member@example.com');
    const base = `/api/v1/workspaces/${owner.workspace.id}/members`;
    expect((await app.inject({ url: base })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${member.user.id}`,
          headers: { origin: headers.origin },
          payload: { role: 'administrator' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${member.user.id}`,
          headers: { ...headers, origin: 'https://evil.example' },
          payload: { role: 'administrator' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${member.user.id}`,
          headers,
          payload: { role: 'instance-admin' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/${member.user.id}`,
          headers: member.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/${owner.user.id}`,
          headers: admin.headers,
        })
      ).statusCode,
    ).toBe(403);
    const other = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload: { name: 'Other' },
      })
    ).json().workspace;
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/workspaces/${other.id}/members/${owner.user.id}`,
          headers: admin.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/workspaces/${other.id}/members/${member.user.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/${member.user.id}`,
          headers: admin.headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${admin.user.id}`,
          headers: admin.headers,
          payload: { role: 'member' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${admin.user.id}`,
          headers: admin.headers,
          payload: { role: 'administrator' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await pool.query(
          "SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner'",
          [owner.workspace.id],
        )
      ).rows,
    ).toEqual([{ user_id: owner.user.id }]);
  });
});

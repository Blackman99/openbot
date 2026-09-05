import { createHash } from 'node:crypto';

import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import {
  LocalAuthService,
  AuthenticationBusyError,
  InvalidCredentialsError,
} from '../../src/auth/service.js';
import {
  InvitationService,
  invitationDigest,
  InvitationUnavailableError,
} from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

const token = Buffer.alloc(32, 7).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };

describe('one-time workspace invitations', () => {
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

  it('creates and inspects an email-bound invitation while storing only its token digest', async () => {
    const { app, owner, pool } = await fixture();
    const path = `/api/v1/workspaces/${owner.workspace.id}/invitations`;
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: { email: ' Grace@Example.com ', role: 'member', expiresInDays: 7 },
    });
    expect(response.statusCode).toBe(201);
    const { invitation, token: inviteToken } = response.json();
    expect(invitation).toMatchObject({
      workspaceId: owner.workspace.id,
      email: 'grace@example.com',
      role: 'member',
      revokedAt: null,
      consumedAt: null,
    });
    expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const stored = (await pool.query('SELECT * FROM workspace_invitations')).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].token_digest).toBe(createHash('sha256').update(inviteToken).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(inviteToken);
    const listed = await app.inject({ url: path, headers });
    expect(listed.json()).toEqual({ invitations: [invitation] });
    expect(listed.body).not.toContain(inviteToken);
    expect(listed.body).not.toContain(stored[0].token_digest);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(
      (
        await pool.query(
          "SELECT event_type, actor_user_id, metadata FROM audit_events WHERE event_type = 'invitation.created'",
        )
      ).rows,
    ).toEqual([
      {
        event_type: 'invitation.created',
        actor_user_id: owner.user.id,
        metadata: { workspaceId: owner.workspace.id, invitationId: invitation.id, role: 'member' },
      },
    ]);
  });
  it('admits a new local account once, authenticates it, and refuses replay without extra records', async () => {
    const { app, owner, pool } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${owner.workspace.id}/invitations`,
      headers,
      payload: { email: 'grace@example.com', role: 'member', expiresInDays: 7 },
    });
    const invite = created.json();
    const input = {
      token: invite.token,
      email: ' Grace@Example.com ',
      displayName: 'Grace',
      password: 'correct horse battery staple',
      role: 'owner',
      isInstanceAdmin: true,
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: { origin: headers.origin },
      payload: input,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({
      user: { displayName: 'Grace', email: 'grace@example.com' },
      workspace: owner.workspace,
    });
    const cookie = String(accepted.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).json()).toEqual(
      accepted.json(),
    );
    expect(
      (await app.inject({ url: '/api/v1/workspaces', headers: { cookie } })).json().workspaces,
    ).toEqual([
      { id: owner.workspace.id, name: owner.workspace.name, description: '', role: 'member' },
    ]);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: { origin: headers.origin },
      payload: input,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ error: { code: 'invitation_unavailable' } });
    expect(
      (
        await pool.query('SELECT is_instance_admin FROM users WHERE normalized_email = $1', [
          'grace@example.com',
        ])
      ).rows,
    ).toEqual([{ is_instance_admin: false }]);
    expect((await pool.query('SELECT * FROM users')).rows).toHaveLength(2);
    expect(
      (
        await pool.query('SELECT password_hash FROM local_credentials WHERE user_id = $1', [
          accepted.json().user.id,
        ])
      ).rows[0].password_hash,
    ).toMatch(/^\$argon2id\$/u);
    expect(
      (
        await pool.query(
          "SELECT metadata FROM audit_events WHERE event_type = 'invitation.accepted'",
        )
      ).rows,
    ).toEqual([
      {
        metadata: {
          workspaceId: owner.workspace.id,
          invitationId: invite.invitation.id,
          role: 'member',
        },
      },
    ]);
  });
  it('lets administrators revoke invites, prevents member management, and rejects revoked/expired/mismatched tokens', async () => {
    const { app, owner, pool } = await fixture();
    const path = `/api/v1/workspaces/${owner.workspace.id}/invitations`;
    const create = async (email = 'grace@example.com') =>
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers,
          payload: { email, role: 'administrator', expiresInDays: 1 },
        })
      ).json();
    const revoked = await create();
    await pool.query("UPDATE workspace_memberships SET role = 'administrator' WHERE user_id = $1", [
      owner.user.id,
    ]);
    expect(
      (await app.inject({ method: 'DELETE', url: `${path}/${revoked.invitation.id}`, headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: `${path}/${revoked.invitation.id}`, headers }))
        .statusCode,
    ).toBe(409);
    const expired = await create();
    await pool.query(
      'UPDATE workspace_invitations SET created_at = $2, expires_at = $3 WHERE id = $1',
      [expired.invitation.id, new Date('2020-01-01'), new Date('2020-01-02')],
    );
    const mismatched = await create('other@example.com');
    for (const token of [
      revoked.token,
      expired.token,
      mismatched.token,
      Buffer.alloc(32, 50).toString('base64url'),
    ]) {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        headers: { origin: headers.origin },
        payload: {
          token,
          email: 'grace@example.com',
          displayName: 'Grace',
          password: 'correct horse battery staple',
        },
      });
      expect(accepted.statusCode).toBe(409);
      expect(accepted.json()).toEqual({ error: { code: 'invitation_unavailable' } });
    }
    await pool.query("UPDATE workspace_memberships SET role = 'member' WHERE user_id = $1", [
      owner.user.id,
    ]);
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: method === 'DELETE' ? `${path}/${mismatched.invitation.id}` : path,
        headers,
        ...(method === 'POST'
          ? { payload: { email: 'new@example.com', role: 'member', expiresInDays: 1 } }
          : {}),
      });
      expect(response.statusCode).toBe(403);
    }
    expect((await pool.query('SELECT * FROM users')).rows).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT actor_user_id, metadata FROM audit_events WHERE event_type = 'invitation.revoked'",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: owner.user.id,
        metadata: { workspaceId: owner.workspace.id, invitationId: revoked.invitation.id },
      },
    ]);
  });
  it('joins signed-in existing users without changing their credentials or accepting a forged email or role', async () => {
    const { app, owner, pool } = await fixture();
    const first = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${owner.workspace.id}/invitations`,
        headers,
        payload: { email: 'grace@example.com', role: 'member', expiresInDays: 7 },
      })
    ).json();
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: { origin: headers.origin },
      payload: {
        token: first.token,
        email: 'grace@example.com',
        displayName: 'Grace',
        password: 'correct horse battery staple',
      },
    });
    const graceHeaders = {
      ...headers,
      cookie: String(joined.headers['set-cookie']).split(';')[0]!,
    };
    const workspace = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload: { name: 'Research' },
      })
    ).json().workspace;
    const invite = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${workspace.id}/invitations`,
        headers,
        payload: { email: 'grace@example.com', role: 'administrator', expiresInDays: 7 },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/invitations/accept',
          headers,
          payload: { token: invite.token, email: 'grace@example.com' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/invitations/accept',
          headers: { origin: headers.origin },
          payload: {
            token: invite.token,
            email: 'grace@example.com',
            displayName: 'Attacker',
            password: 'attacker password123',
          },
        })
      ).statusCode,
    ).toBe(409);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: graceHeaders,
      payload: {
        token: invite.token,
        email: 'ada@example.com',
        role: 'owner',
        password: 'attacker password123',
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['set-cookie']).toBeUndefined();
    expect(accepted.json()).toEqual({
      user: joined.json().user,
      workspace: { id: workspace.id, name: 'Research' },
    });
    expect(
      (
        await pool.query(
          'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
          [workspace.id, joined.json().user.id],
        )
      ).rows,
    ).toEqual([{ role: 'administrator' }]);
    expect((await pool.query('SELECT * FROM users')).rows).toHaveLength(2);
    expect((await pool.query('SELECT * FROM sessions')).rows).toHaveLength(2);
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace.id}/invitations`,
      headers: graceHeaders,
      payload: { email: 'third@example.com', role: 'owner', expiresInDays: 7 },
    });
    expect(denied.statusCode).toBe(400);
  });

  it('rejects unauthenticated/cross-origin administration and invalid grants without creating accounts', async () => {
    const { app, owner, pool } = await fixture();
    const path = `/api/v1/workspaces/${owner.workspace.id}/invitations`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { origin: headers.origin },
          payload: { email: 'new@example.com', role: 'member', expiresInDays: 1 },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { ...headers, origin: 'https://evil.example' },
          payload: { email: 'new@example.com', role: 'member', expiresInDays: 1 },
        })
      ).statusCode,
    ).toBe(403);
    for (const input of [
      { role: 'owner' },
      { expiresInDays: 0 },
      { expiresInDays: 31 },
      { expiresInDays: 1.5 },
      { email: 'invalid' },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            headers,
            payload: { email: 'new@example.com', role: 'member', expiresInDays: 1, ...input },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/register',
          headers,
          payload: { email: 'new@example.com', password: 'correct horse battery staple' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/invitations/accept',
          headers: { origin: 'https://evil.example' },
          payload: { token: Buffer.alloc(32, 2).toString('base64url') },
        })
      ).statusCode,
    ).toBe(403);
    expect((await pool.query('SELECT * FROM users')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM workspace_invitations')).rows).toHaveLength(0);
  });

  it('throttles invalid acceptance attempts before password work', async () => {
    const { app } = await fixture();
    const request = {
      method: 'POST' as const,
      url: '/api/v1/invitations/accept',
      headers: { origin: headers.origin },
      payload: { token: Buffer.alloc(32, 2).toString('base64url'), email: 'new@example.com' },
    };
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await app.inject(request)).statusCode).toBe(409);
    const limited = await app.inject(request);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
  it('rechecks expiry after waiting for the workspace lock', async () => {
    const { app, owner, pool } = await fixture();
    const invite = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${owner.workspace.id}/invitations`,
        headers,
        payload: { email: owner.user.email, role: 'member', expiresInDays: 1 },
      })
    ).json();
    const other = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload: { name: 'Unrelated' },
      })
    ).json().workspace;
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [
      owner.workspace.id,
    ]);
    const beforeExpiry = new Date(Date.now() + 60_000);
    await pool.query('UPDATE workspace_invitations SET expires_at = $2 WHERE id = $1', [
      invite.invitation.id,
      beforeExpiry,
    ]);
    // Simulate the clock moving forward while SQL waits on the workspace lock.
    const repository = new PostgresInvitationRepository(
      pool,
      () => new Date(beforeExpiry.getTime() + 1),
    );
    await expect(
      repository.accept({
        tokenDigest: invitationDigest(invite.token),
        email: owner.user.email,
        userId: owner.user.id,
        now: new Date(beforeExpiry.getTime() - 1),
        auditId: other.id,
      }),
    ).rejects.toBeInstanceOf(InvitationUnavailableError);
    expect(
      (
        await pool.query('SELECT consumed_at FROM workspace_invitations WHERE id = $1', [
          invite.invitation.id,
        ])
      ).rows,
    ).toEqual([{ consumed_at: null }]);
  });
  it('accepts invitations with unrelated browser cookies and hides foreign-workspace invitations', async () => {
    const { app, owner } = await fixture();
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
      headers: { origin: headers.origin, cookie: 'theme=dark' },
      payload: {
        token: created.token,
        email: 'grace@example.com',
        displayName: 'Grace',
        password: 'correct horse battery staple',
      },
    });
    expect(accepted.statusCode).toBe(201);
    const workspace = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload: { name: 'Private' },
      })
    ).json().workspace;
    const privatePath = `/api/v1/workspaces/${workspace.id}/invitations`;
    const privateInvite = (
      await app.inject({
        method: 'POST',
        url: privatePath,
        headers,
        payload: { email: 'private@example.com', role: 'member', expiresInDays: 1 },
      })
    ).json();
    const graceHeaders = {
      ...headers,
      cookie: String(accepted.headers['set-cookie']).split(';')[0]!,
      'x-workspace-role': 'owner',
    };
    const listed = await app.inject({ url: privatePath, headers: graceHeaders });
    expect(listed.statusCode).toBe(403);
    expect(listed.body).not.toContain('private@example.com');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${privatePath}/${privateInvite.invitation.id}`,
          headers: graceHeaders,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: privatePath, headers })).json().invitations[0].revokedAt,
    ).toBeNull();
  });
  it('does not disclose invitation email addresses after a concurrent administrator demotion', async () => {
    const { app, owner, pool } = await fixture();
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${owner.workspace.id}/invitations`,
      headers,
      payload: { email: 'private@example.com', role: 'member', expiresInDays: 1 },
    });
    const repository = new PostgresInvitationRepository({
      connect: async () => {
        const connection = await pool.connect();
        return {
          release: () => connection.release(),
          query: async (statement, parameters) => {
            const result = await connection.query(statement, parameters);
            if (statement.startsWith('SELECT role FROM workspace_memberships'))
              await pool.query(
                "UPDATE workspace_memberships SET role = 'member' WHERE user_id = $1",
                [owner.user.id],
              );
            return result;
          },
        };
      },
    });
    await expect(repository.list(owner.user.id, owner.workspace.id)).resolves.toEqual([]);
  });
  it('shares the two-operation password budget between sign-in and invited signup', async () => {
    const { app, owner, pool } = await fixture();
    const invitation = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${owner.workspace.id}/invitations`,
        headers,
        payload: { email: 'grace@example.com', role: 'member', expiresInDays: 1 },
      })
    ).json();
    const release: Array<() => void> = [];
    let started = 0;
    const hold = async () => {
      started += 1;
      if (started > 2) return;
      await new Promise<void>((resolve) => release.push(resolve));
    };
    const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
      verifyPassword: async () => {
        await hold();
        return false;
      },
    });
    const invites = new InvitationService(
      new PostgresInvitationRepository(pool),
      () => new Date(),
      async () => {
        await hold();
        return '$argon2id$test-only';
      },
    );
    const first = auth
      .signIn({ email: owner.user.email, password: 'correct horse battery staple' })
      .catch((error) => error);
    const second = invites
      .accept({
        token: invitation.token,
        email: 'grace@example.com',
        displayName: 'Grace',
        password: 'correct horse battery staple',
      })
      .catch((error) => error);
    await vi.waitFor(() => expect(started).toBe(2));
    const third = await auth
      .signIn({ email: owner.user.email, password: 'correct horse battery staple' })
      .catch((error) => error);
    release.forEach((resolve) => resolve());
    await Promise.all([first, second]);
    expect(third).toBeInstanceOf(AuthenticationBusyError);
    expect(started).toBe(2);
    await expect(
      auth.signIn({ email: owner.user.email, password: 'correct horse battery staple' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});

import { newMemDatabase } from '../helpers/provider-database.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { GroupAccessError, GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { InvitationService } from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { GroupApiClient } from '../../../web/src/lib/server/group-api.js';

const token = Buffer.alloc(32, 9).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };

describe('group lifecycle and explicit human membership', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  async function fixture() {
    const database = newMemDatabase();
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
    const groups = new GroupService(new PostgresGroupRepository(pool));
    const app = buildApp({
      auth,
      groups,
      members: new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(pool)),
      invitations: new InvitationService(
        new PostgresInvitationRepository(pool),
        () => new Date(),
        async () => '$argon2id$test-only',
      ),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    return { app, owner, pool, groups };
  }
  async function workspaceUser(
    context: Awaited<ReturnType<typeof fixture>>,
    email: string,
    workspaceRole = 'member',
  ) {
    const id = randomUUID();
    const sessionToken = randomBytes(32).toString('base64url');
    const now = new Date();
    await context.pool.query(
      'INSERT INTO users (id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$2,$3)',
      [id, email, now],
    );
    await context.pool.query(
      'INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,$3,$4)',
      [context.owner.workspace.id, id, workspaceRole, now],
    );
    await new PostgresAuthRepository(context.pool).createSession({
      auditId: randomUUID(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3600000),
      tokenDigest: createHash('sha256').update(sessionToken).digest('hex'),
      userId: id,
    });
    return { id, email, headers: { ...headers, cookie: `openbot_session=${sessionToken}` } };
  }
  it('creates a persistent private group with its creator as its explicit owner by default', async () => {
    const { app, owner, pool } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${owner.workspace.id}/groups`,
      headers,
      payload: { name: 'Incident room' },
    });
    expect(response.statusCode).toBe(201);
    const { group } = response.json();
    expect(group).toEqual({
      id: expect.any(String),
      workspaceId: owner.workspace.id,
      name: 'Incident room',
      description: '',
      visibility: 'private',
      role: 'owner',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(
      (
        await pool.query('SELECT user_id, role FROM group_memberships WHERE group_id = $1', [
          group.id,
        ])
      ).rows,
    ).toEqual([{ user_id: owner.user.id, role: 'owner' }]);
    expect(
      (await pool.query("SELECT metadata FROM audit_events WHERE event_type = 'group.created'"))
        .rows,
    ).toEqual([
      { metadata: { groupId: group.id, workspaceId: owner.workspace.id, visibility: 'private' } },
    ]);
  });
  it('lists private metadata only for explicit members and workspace metadata for current workspace members', async () => {
    const context = await fixture();
    const { app, owner } = context;
    const workspaceOwner = await workspaceUser(context, 'second-owner@example.com', 'owner');
    const path = `/api/v1/workspaces/${owner.workspace.id}/groups`;
    const privateGroup = (
      await app.inject({ method: 'POST', url: path, headers, payload: { name: 'Secret room' } })
    ).json().group;
    const publicGroup = (
      await app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { name: 'Discoverable', description: 'Public purpose', visibility: 'workspace' },
      })
    ).json().group;
    const listing = await app.inject({ url: path, headers: workspaceOwner.headers });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toEqual({ groups: [{ ...publicGroup, role: null }] });
    expect(
      (await app.inject({ url: `${path}/${privateGroup.id}`, headers: workspaceOwner.headers }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({ url: `${path}/${publicGroup.id}`, headers: workspaceOwner.headers })
      ).json(),
    ).toEqual({ group: { ...publicGroup, role: null } });
    expect((await app.inject({ url: `${path}/${privateGroup.id}`, headers })).json()).toEqual({
      group: privateGroup,
    });
    expect((await app.inject({ url: path, headers })).json().groups).toHaveLength(2);
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: `/api/v1/workspaces/${randomUUID()}/groups/${publicGroup.id}`,
          headers: workspaceOwner.headers,
        })
      ).statusCode,
    ).toBe(403);
    await context.pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [
      workspaceOwner.id,
    ]);
    expect((await app.inject({ url: path, headers: workspaceOwner.headers })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: `${path}/${publicGroup.id}`, headers: workspaceOwner.headers }))
        .statusCode,
    ).toBe(403);
  });
  it('requires explicit group membership for human-member content and subscription admission even for discoverable groups', async () => {
    const context = await fixture();
    const { app, owner, groups } = context;
    const outsider = await workspaceUser(context, 'workspace-admin@example.com', 'administrator');
    const base = `/api/v1/workspaces/${owner.workspace.id}/groups`;
    const group = (
      await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { name: 'Visible project', visibility: 'workspace' },
      })
    ).json().group;
    expect(
      (await app.inject({ url: `${base}/${group.id}/members`, headers: outsider.headers }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ url: `${base}/${group.id}/members`, headers })).json()).toEqual({
      members: [
        { user: owner.user, role: 'owner', joinedAt: expect.any(String), hasWorkspaceAccess: true },
      ],
    });
    await expect(
      groups.authorizeContent(outsider.id, owner.workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
    await expect(
      groups.authorizeSubscription(outsider.id, owner.workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
    await expect(
      groups.authorizeContent(owner.user.id, owner.workspace.id, group.id),
    ).resolves.toMatchObject({ id: group.id, role: 'owner' });
    await expect(
      groups.authorizeSubscription(owner.user.id, owner.workspace.id, group.id),
    ).resolves.toMatchObject({ id: group.id, role: 'owner' });
    await context.pool.query('DELETE FROM workspace_memberships WHERE user_id=$1', [owner.user.id]);
    expect((await app.inject({ url: `${base}/${group.id}/members`, headers })).statusCode).toBe(
      403,
    );
    await expect(
      groups.authorizeContent(owner.user.id, owner.workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
    await expect(
      groups.authorizeSubscription(owner.user.id, owner.workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
  });
  it('adds only current workspace users through explicit group owners or admins without duplicate-role escalation', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const member = await workspaceUser(context, 'member@example.com');
    const admin = await workspaceUser(context, 'admin@example.com');
    const third = await workspaceUser(context, 'third@example.com');
    const path = `/api/v1/workspaces/${owner.workspace.id}/groups`;
    const group = (
      await app.inject({ method: 'POST', url: path, headers, payload: { name: 'Private team' } })
    ).json().group;
    const members = `${path}/${group.id}/members`;
    const added = await app.inject({
      method: 'POST',
      url: members,
      headers,
      payload: { userId: member.id },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({
      member: {
        user: { id: member.id, email: member.email, displayName: member.email },
        role: 'member',
        joinedAt: expect.any(String),
        hasWorkspaceAccess: true,
      },
    });
    expect(
      (await app.inject({ url: `${path}/${group.id}`, headers: member.headers })).statusCode,
    ).toBe(200);
    await expect(
      context.groups.authorizeSubscription(member.id, owner.workspace.id, group.id),
    ).resolves.toMatchObject({ role: 'member' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: members,
          headers: member.headers,
          payload: { userId: third.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: members,
          headers: admin.headers,
          payload: { userId: third.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: members,
          headers,
          payload: { userId: member.id, role: 'owner' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: members,
          headers,
          payload: { userId: randomUUID() },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: members,
          headers,
          payload: { userId: admin.id, role: 'admin' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: members,
          headers: admin.headers,
          payload: { userId: third.id, role: 'owner' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: members,
          headers: admin.headers,
          payload: { userId: third.id },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await pool.query(
          "SELECT metadata FROM audit_events WHERE event_type='group.member_added' ORDER BY occurred_at",
        )
      ).rows.map((row: { metadata: unknown }) => row.metadata),
    ).toEqual([
      {
        groupId: group.id,
        workspaceId: owner.workspace.id,
        targetUserId: member.id,
        role: 'member',
      },
      { groupId: group.id, workspaceId: owner.workspace.id, targetUserId: admin.id, role: 'admin' },
      {
        groupId: group.id,
        workspaceId: owner.workspace.id,
        targetUserId: third.id,
        role: 'member',
      },
    ]);
  });
  it('changes group roles within authority and protects the last currently eligible owner', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const peer = await workspaceUser(context, 'peer@example.com');
    const path = `/api/v1/workspaces/${owner.workspace.id}/groups`;
    const group = (
      await app.inject({ method: 'POST', url: path, headers, payload: { name: 'Ownership' } })
    ).json().group;
    const base = `${path}/${group.id}/members`;
    await app.inject({
      method: 'POST',
      url: base,
      headers,
      payload: { userId: peer.id, role: 'admin' },
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${owner.user.id}`,
          headers,
          payload: { role: 'member' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${owner.user.id}`,
          headers: peer.headers,
          payload: { role: 'member' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${peer.id}`,
          headers: peer.headers,
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${peer.id}`,
          headers,
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(200);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id=$1', [peer.id]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${owner.user.id}`,
          headers,
          payload: { role: 'member' },
        })
      ).statusCode,
    ).toBe(409);
    expect((await app.inject({ url: base, headers })).json().members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user: expect.objectContaining({ id: peer.id }),
          role: 'owner',
          hasWorkspaceAccess: false,
        }),
      ]),
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${peer.id}`,
          headers,
          payload: { role: 'member' },
        })
      ).statusCode,
    ).toBe(200);
    await pool.query(
      "INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,'member',NOW())",
      [owner.workspace.id, peer.id],
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${peer.id}`,
          headers,
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${owner.user.id}`,
          headers,
          payload: { role: 'admin' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${peer.id}`,
          headers,
          payload: { role: 'member' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${owner.user.id}`,
          headers: peer.headers,
          payload: { role: 'member' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${owner.user.id}`,
          headers,
          payload: { role: 'admin' },
        })
      ).statusCode,
    ).toBe(403);
    const auditCount = (
      await pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE event_type='group.member_role_changed'",
      )
    ).rows[0].count;
    expect(auditCount).toBe(5);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/${peer.id}`,
          headers: peer.headers,
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE event_type='group.member_role_changed'",
        )
      ).rows[0].count,
    ).toBe(auditCount);
  });
  it('removes explicit group grants immediately while preserving historical creators, users, sessions, and audits', async () => {
    const context = await fixture();
    const { app, owner, pool, groups } = context;
    const peer = await workspaceUser(context, 'peer@example.com');
    const path = `/api/v1/workspaces/${owner.workspace.id}/groups`;
    const group = (
      await app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { name: 'Visible history', visibility: 'workspace' },
      })
    ).json().group;
    const base = `${path}/${group.id}/members`;
    expect(
      (await app.inject({ method: 'DELETE', url: `${base}/${owner.user.id}`, headers })).statusCode,
    ).toBe(409);
    await app.inject({
      method: 'POST',
      url: base,
      headers,
      payload: { userId: peer.id, role: 'admin' },
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/${owner.user.id}`,
          headers: peer.headers,
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({
      method: 'PATCH',
      url: `${base}/${peer.id}`,
      headers,
      payload: { role: 'owner' },
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/${owner.user.id}`,
          headers: peer.headers,
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject({ url: `${path}/${group.id}`, headers })).json()).toMatchObject({
      group: { role: null },
    });
    expect((await app.inject({ url: base, headers })).statusCode).toBe(403);
    await expect(
      groups.authorizeContent(owner.user.id, owner.workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
    await expect(
      groups.authorizeSubscription(owner.user.id, owner.workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
    expect((await app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(200);
    expect(
      (await pool.query('SELECT created_by_user_id FROM groups WHERE id=$1', [group.id])).rows,
    ).toEqual([{ created_by_user_id: owner.user.id }]);
    expect(
      (await pool.query('SELECT id FROM users WHERE id=$1', [owner.user.id])).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query('SELECT user_id FROM local_credentials WHERE user_id=$1', [owner.user.id]))
        .rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query('SELECT user_id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [
          owner.user.id,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query("SELECT actor_user_id FROM audit_events WHERE event_type='group.created'"))
        .rows,
    ).toEqual([{ actor_user_id: owner.user.id }]);
    expect(
      (
        await pool.query(
          "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='group.member_removed'",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: peer.id,
        metadata: {
          groupId: group.id,
          workspaceId: owner.workspace.id,
          targetUserId: owner.user.id,
          role: 'owner',
        },
      },
    ]);
    expect(
      (await app.inject({ method: 'POST', url: base, headers, payload: { userId: owner.user.id } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base,
          headers: peer.headers,
          payload: { userId: owner.user.id },
        })
      ).statusCode,
    ).toBe(201);
    await expect(
      groups.authorizeSubscription(owner.user.id, owner.workspace.id, group.id),
    ).resolves.toMatchObject({ role: 'member' });
    expect(
      (await app.inject({ method: 'DELETE', url: `${base}/${owner.user.id}`, headers })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/${owner.user.id}`,
          headers: peer.headers,
        })
      ).statusCode,
    ).toBe(204);
  });
  it('edits group metadata within explicit authority and makes visibility changes take effect immediately', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const admin = await workspaceUser(context, 'admin@example.com');
    const outsider = await workspaceUser(context, 'outsider@example.com', 'owner');
    const base = `/api/v1/workspaces/${owner.workspace.id}/groups`;
    const group = (
      await app.inject({ method: 'POST', url: base, headers, payload: { name: 'Private room' } })
    ).json().group;
    const path = `${base}/${group.id}`;
    const updated = await app.inject({
      method: 'PATCH',
      url: path,
      headers,
      payload: { name: 'Renamed room', visibility: 'workspace' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().group).toMatchObject({
      id: group.id,
      name: 'Renamed room',
      visibility: 'workspace',
      description: '',
    });
    expect((await app.inject({ url: path, headers: outsider.headers })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: path,
          headers: outsider.headers,
          payload: { name: 'Hijacked' },
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({
      method: 'POST',
      url: `${path}/members`,
      headers,
      payload: { userId: admin.id, role: 'admin' },
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: path,
          headers: admin.headers,
          payload: { description: 'Team purpose' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: path, headers: outsider.headers })).json().group).toMatchObject(
      { visibility: 'workspace', description: 'Team purpose' },
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: path,
          headers: admin.headers,
          payload: { visibility: 'private' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: path, headers: outsider.headers })).statusCode).toBe(403);
    for (const input of [
      { name: '' },
      { visibility: 'public' },
      { description: 'x'.repeat(2001) },
      {},
      { ownerId: outsider.id },
    ])
      expect(
        (await app.inject({ method: 'PATCH', url: path, headers, payload: input })).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: path,
          headers,
          payload: { visibility: 'private' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT metadata FROM audit_events WHERE event_type='group.metadata_changed' ORDER BY occurred_at",
        )
      ).rows.map((row: { metadata: unknown }) => row.metadata),
    ).toEqual([
      { groupId: group.id, workspaceId: owner.workspace.id, changedFields: ['name', 'visibility'] },
      { groupId: group.id, workspaceId: owner.workspace.id, changedFields: ['description'] },
      { groupId: group.id, workspaceId: owner.workspace.id, changedFields: ['visibility'] },
    ]);
  });
  it('intersects retained group grants with current workspace membership and restores them only after workspace re-invitation', async () => {
    const context = await fixture();
    const { app, owner, pool, groups } = context;
    const creator = await workspaceUser(context, 'creator@example.com');
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const group = (
      await app.inject({
        method: 'POST',
        url: `${base}/groups`,
        headers: creator.headers,
        payload: { name: 'Creator private room' },
      })
    ).json().group;
    expect((await app.inject({ url: `${base}/groups/${group.id}`, headers })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'DELETE', url: `${base}/members/${creator.id}`, headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ url: `${base}/groups/${group.id}`, headers: creator.headers }))
        .statusCode,
    ).toBe(403);
    await expect(
      groups.authorizeContent(creator.id, owner.workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
    await expect(
      groups.authorizeSubscription(creator.id, owner.workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
    expect((await app.inject({ url: `${base}/groups/${group.id}`, headers })).statusCode).toBe(403);
    expect(
      (
        await pool.query('SELECT role FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
          group.id,
          creator.id,
        ])
      ).rows,
    ).toEqual([{ role: 'owner' }]);
    expect(
      (await app.inject({ url: '/api/v1/me', headers: creator.headers })).json(),
    ).toMatchObject({ user: { id: creator.id }, workspace: null });
    const invitation = (
      await app.inject({
        method: 'POST',
        url: `${base}/invitations`,
        headers,
        payload: { email: creator.email, role: 'member', expiresInDays: 1 },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/invitations/accept',
          headers: creator.headers,
          payload: { token: invitation.token },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: `${base}/groups/${group.id}`, headers: creator.headers })).json(),
    ).toMatchObject({ group: { id: group.id, role: 'owner' } });
    await expect(
      groups.authorizeSubscription(creator.id, owner.workspace.id, group.id),
    ).resolves.toMatchObject({ role: 'owner' });
    expect((await app.inject({ url: `${base}/groups/${group.id}`, headers })).statusCode).toBe(403);
  });
  it('rejects invalid input, untrusted writes and cross-workspace targets without changing membership', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const other = await workspaceUser(context, 'other@example.com');
    await pool.query('DELETE FROM workspace_memberships WHERE user_id=$1', [other.id]);
    const path = `/api/v1/workspaces/${owner.workspace.id}/groups`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { origin: headers.origin },
          payload: { name: 'Anonymous' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { ...headers, origin: 'https://untrusted.example' },
          payload: { name: 'CSRF' },
        })
      ).statusCode,
    ).toBe(403);
    for (const input of [
      { name: '' },
      { name: 'x'.repeat(101) },
      { name: 'Name', description: 'x'.repeat(2001) },
      { name: 'Name', visibility: 'public' },
    ])
      expect(
        (await app.inject({ method: 'POST', url: path, headers, payload: input })).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: other.headers,
          payload: { name: 'Not a workspace member' },
        })
      ).statusCode,
    ).toBe(403);
    const group = (
      await app.inject({ method: 'POST', url: path, headers, payload: { name: 'Valid' } })
    ).json().group;
    const base = `${path}/${group.id}`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/members`,
          headers,
          payload: { userId: other.id },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/members`,
          headers,
          payload: { userId: 'bad-id' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${base}/members/${owner.user.id}`,
          headers,
          payload: { role: 'administrator' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/members/${owner.user.id}`,
          headers: { cookie: headers.cookie },
        })
      ).statusCode,
    ).toBe(403);
    const foreign = await app.inject({
      url: `/api/v1/workspaces/${randomUUID()}/groups/${group.id}/members`,
      headers,
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ url: `${base}/members`, headers })).json().members).toHaveLength(1);
    expect((await pool.query('SELECT id FROM groups')).rows).toHaveLength(1);
  });
  it('uses canonical UUIDs for group responses and audit scope even when request IDs use uppercase', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const peer = await workspaceUser(context, 'case-peer@example.com');
    const upperWorkspace = owner.workspace.id.toUpperCase();
    const path = `/api/v1/workspaces/${upperWorkspace}/groups`;
    const created = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: { name: 'Canonical room' },
    });
    expect(created.statusCode).toBe(201);
    const group = created.json().group;
    expect(group.workspaceId).toBe(owner.workspace.id);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${path}/${group.id.toUpperCase()}`,
          headers,
          payload: { description: 'Canonical scope' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${path}/${group.id.toUpperCase()}/members`,
          headers,
          payload: { userId: peer.id.toUpperCase() },
        })
      ).statusCode,
    ).toBe(201);
    const events = (
      await pool.query(
        "SELECT event_type,metadata FROM audit_events WHERE metadata->>'groupId'=$1 ORDER BY occurred_at",
        [group.id],
      )
    ).rows;
    expect(events).toHaveLength(3);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          event_type: 'group.created',
          metadata: { groupId: group.id, workspaceId: owner.workspace.id, visibility: 'private' },
        },
        {
          event_type: 'group.metadata_changed',
          metadata: {
            groupId: group.id,
            workspaceId: owner.workspace.id,
            changedFields: ['description'],
          },
        },
        {
          event_type: 'group.member_added',
          metadata: {
            groupId: group.id,
            workspaceId: owner.workspace.id,
            targetUserId: peer.id,
            role: 'member',
          },
        },
      ]),
    );
  });
  it('supports the Web group client through actual HTTP persistence and bodyless membership removal', async () => {
    const context = await fixture();
    const { app, owner, pool } = context;
    const peer = await workspaceUser(context, 'http-peer@example.com');
    const peerToken = peer.headers.cookie.slice('openbot_session='.length);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new GroupApiClient(fetch, address, headers.origin);
    const created = await client.create(token, owner.workspace.id, { name: 'HTTP group' });
    expect(created.status).toBe('available');
    if (created.status !== 'available') throw new Error('Expected a created group');
    const group = created.value;
    expect(await client.get(peerToken, owner.workspace.id, group.id)).toEqual({
      status: 'forbidden',
    });
    expect(await client.list(token, owner.workspace.id)).toMatchObject({
      status: 'available',
      value: [{ id: group.id, role: 'owner' }],
    });
    expect(
      await client.update(token, owner.workspace.id, group.id, {
        visibility: 'workspace',
        description: 'Shared metadata',
      }),
    ).toMatchObject({
      status: 'available',
      value: { visibility: 'workspace', description: 'Shared metadata' },
    });
    expect(await client.get(peerToken, owner.workspace.id, group.id)).toMatchObject({
      status: 'available',
      value: { role: null },
    });
    expect(await client.members(peerToken, owner.workspace.id, group.id)).toEqual({
      status: 'forbidden',
    });
    expect(
      await client.addMember(token, owner.workspace.id, group.id, peer.id, 'admin'),
    ).toMatchObject({ status: 'available', value: { user: { id: peer.id }, role: 'admin' } });
    expect(
      await client.changeRole(peerToken, owner.workspace.id, group.id, owner.user.id, 'member'),
    ).toEqual({ status: 'forbidden' });
    expect(
      await client.changeRole(token, owner.workspace.id, group.id, peer.id, 'member'),
    ).toMatchObject({ status: 'available', value: { role: 'member' } });
    expect(await client.removeMember(token, owner.workspace.id, group.id, peer.id)).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(await client.members(peerToken, owner.workspace.id, group.id)).toEqual({
      status: 'forbidden',
    });
    expect(await client.removeMember(token, owner.workspace.id, group.id, owner.user.id)).toEqual({
      status: 'last-owner',
    });
    expect(
      (await pool.query('SELECT user_id FROM group_memberships WHERE group_id=$1', [group.id]))
        .rows,
    ).toEqual([{ user_id: owner.user.id }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE event_type='group.member_removed'",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
});

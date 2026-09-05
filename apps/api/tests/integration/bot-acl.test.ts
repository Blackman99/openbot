import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { BotAccessError } from '../../src/bots/service.js';
import { lockAuthorizedBot, type BotPermission } from '../../src/bots/postgres-bot-access.js';

describe('independent Bot ACL and visibility', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  async function permission(
    f: Awaited<ReturnType<typeof botAclFixture>>,
    actorUserId: string,
    requested: BotPermission,
  ) {
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      await lockAuthorizedBot(
        connection,
        { actorUserId, workspaceId: f.owner.workspace.id, botId: f.bot.id },
        requested,
      );
      await connection.query('COMMIT');
      return true;
    } catch (error) {
      await connection.query('ROLLBACK');
      if (error instanceof BotAccessError) return false;
      throw error;
    } finally {
      connection.release();
    }
  }
  const permissions: BotPermission[] = [
    'discover',
    'inspect',
    'use',
    'edit',
    'manageAcl',
    'manageLifecycle',
  ];
  it('lets an owner grant a same-workspace editor, reveal private configuration and record safe audit metadata', async () => {
    const f = await botAclFixture(cleanup);
    const target = await f.addUser();
    const url = `${f.path}/${f.bot.id}/acl`;
    const added = await f.app.inject({
      method: 'POST',
      url,
      headers: f.headers,
      payload: { userId: target.id, role: 'editor' },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({
      member: {
        user: { id: target.id, email: target.email, displayName: 'Workspace member' },
        role: 'editor',
        joinedAt: expect.any(String),
        hasWorkspaceAccess: true,
      },
    });
    expect(added.headers['cache-control']).toBe('private, no-store');
    const visible = await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: target.headers });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().bot.accessRole).toBe('editor');
    expect(visible.json().bot.currentVersion.id).toBe(f.bot.currentVersion.id);
    const listed = await f.app.inject({ url, headers: f.headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().members.map((member: { role: string }) => member.role)).toEqual([
      'owner',
      'editor',
    ]);
    expect(
      (
        await f.pool.query(
          "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='bot.acl_granted'",
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: f.owner.user.id,
        metadata: {
          workspaceId: f.owner.workspace.id,
          botId: f.bot.id,
          targetUserId: target.id,
          role: 'editor',
        },
      },
    ]);
    expect(added.body + listed.body).not.toContain('never-return-provider-secret');
  });
  it('changes owner/editor/user grants and revokes authority on the next request without changing version history', async () => {
    const f = await botAclFixture(cleanup),
      target = await f.addUser();
    const url = `${f.path}/${f.bot.id}/acl`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { userId: target.id },
        })
      ).statusCode,
    ).toBe(201);
    expect(await Promise.all(permissions.map((p) => permission(f, target.id, p)))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    for (const [role, allowed] of [
      ['editor', [true, true, true, true, false, false]],
      ['owner', [true, true, true, true, true, true]],
      ['user', [true, true, true, false, false, false]],
    ] as const) {
      const response = await f.app.inject({
        method: 'PATCH',
        url: `${url}/${target.id}`,
        headers: f.headers,
        payload: { role },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().member.role).toBe(role);
      expect(await Promise.all(permissions.map((p) => permission(f, target.id, p)))).toEqual(
        allowed,
      );
    }
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `${url}/${target.id}`,
          headers: f.headers,
          payload: { role: 'user' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.pool.query(
          "SELECT metadata FROM audit_events WHERE event_type='bot.acl_role_changed'",
        )
      ).rows,
    ).toEqual([
      {
        metadata: {
          workspaceId: f.owner.workspace.id,
          botId: f.bot.id,
          targetUserId: target.id,
          fromRole: 'user',
          toRole: 'editor',
        },
      },
      {
        metadata: {
          workspaceId: f.owner.workspace.id,
          botId: f.bot.id,
          targetUserId: target.id,
          fromRole: 'editor',
          toRole: 'owner',
        },
      },
      {
        metadata: {
          workspaceId: f.owner.workspace.id,
          botId: f.bot.id,
          targetUserId: target.id,
          fromRole: 'owner',
          toRole: 'user',
        },
      },
    ]);
    expect(
      (await f.app.inject({ method: 'DELETE', url: `${url}/${target.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: target.headers })).statusCode,
    ).toBe(403);
    expect(await Promise.all(permissions.map((p) => permission(f, target.id, p)))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      (await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='bot.acl_revoked'"))
        .rows,
    ).toEqual([
      {
        metadata: {
          workspaceId: f.owner.workspace.id,
          botId: f.bot.id,
          targetUserId: target.id,
          role: 'user',
        },
      },
    ]);
    expect(
      (await f.pool.query('SELECT id FROM bot_versions WHERE bot_id=$1', [f.bot.id])).rows,
    ).toEqual([{ id: f.bot.currentVersion.id }]);
  });
  it('changes workspace visibility to discovery only and preserves immutable configuration and pointer', async () => {
    const f = await botAclFixture(cleanup),
      observer = await f.addUser('administrator');
    const url = `${f.path}/${f.bot.id}`;
    expect((await f.app.inject({ url: f.path, headers: observer.headers })).json().bots).toEqual(
      [],
    );
    for (const visibility of ['workspace', 'workspace', 'private'] as const) {
      const result = await f.app.inject({
        method: 'PATCH',
        url: `${url}/visibility`,
        headers: f.headers,
        payload: { visibility },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ visibility });
      const detail = await f.app.inject({ url, headers: observer.headers });
      if (visibility === 'workspace') {
        expect(detail.statusCode).toBe(200);
        expect(detail.json().bot.accessRole).toBeNull();
        expect(detail.json().bot.currentVersion).toBeUndefined();
        expect(detail.body).not.toContain(f.model.id);
        expect(detail.body).not.toContain('Instructions visible only');
        expect(await Promise.all(permissions.map((p) => permission(f, observer.id, p)))).toEqual([
          true,
          false,
          false,
          false,
          false,
          false,
        ]);
      } else expect(detail.statusCode).toBe(403);
    }
    expect(
      (
        await f.pool.query(
          "SELECT metadata FROM audit_events WHERE event_type='bot.visibility_changed'",
        )
      ).rows,
    ).toEqual([
      {
        metadata: {
          workspaceId: f.owner.workspace.id,
          botId: f.bot.id,
          fromVisibility: 'private',
          toVisibility: 'workspace',
        },
      },
      {
        metadata: {
          workspaceId: f.owner.workspace.id,
          botId: f.bot.id,
          fromVisibility: 'workspace',
          toVisibility: 'private',
        },
      },
    ]);
    expect(
      (await f.pool.query('SELECT current_version_id FROM bots WHERE id=$1', [f.bot.id])).rows,
    ).toEqual([{ current_version_id: f.bot.currentVersion.id }]);
  });
  it('protects the last currently eligible owner even with a retained inactive owner grant', async () => {
    const f = await botAclFixture(cleanup),
      other = await f.addUser();
    const url = `${f.path}/${f.bot.id}/acl`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { userId: other.id, role: 'owner' },
        })
      ).statusCode,
    ).toBe(201);
    const removed = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/members/${other.id}`,
      headers: f.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect((await f.app.inject({ url, headers: other.headers })).statusCode).toBe(403);
    const retained = (await f.app.inject({ url, headers: f.headers })).json().members;
    expect(
      retained.find((item: { user: { id: string } }) => item.user.id === other.id)
        .hasWorkspaceAccess,
    ).toBe(false);
    for (const request of [
      { method: 'DELETE' as const },
      { method: 'PATCH' as const, payload: { role: 'editor' } },
    ]) {
      const response = await f.app.inject({
        ...request,
        url: `${url}/${f.owner.user.id}`,
        headers: f.headers,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: { code: 'last_bot_owner_required' } });
    }
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `${url}/${other.id}`,
          headers: f.headers,
          payload: { role: 'user' },
        })
      ).statusCode,
    ).toBe(200);
    const promotion = await f.app.inject({
      method: 'PATCH',
      url: `${url}/${other.id}`,
      headers: f.headers,
      payload: { role: 'owner' },
    });
    expect(promotion.statusCode).toBe(404);
    expect(
      (await f.app.inject({ method: 'DELETE', url: `${url}/${other.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await f.pool.query('SELECT user_id,role FROM bot_acl WHERE bot_id=$1', [f.bot.id])).rows,
    ).toEqual([{ user_id: f.owner.user.id, role: 'owner' }]);
  });
  it('revokes configuration and use immediately while preserving configured workspace discovery', async () => {
    const f = await botAclFixture(cleanup),
      target = await f.addUser();
    const url = `${f.path}/${f.bot.id}`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${url}/acl`,
          headers: f.headers,
          payload: { userId: target.id },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `${url}/visibility`,
          headers: f.headers,
          payload: { visibility: 'workspace' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.app.inject({ url, headers: target.headers })).json().bot.currentVersion.id,
    ).toBe(f.bot.currentVersion.id);
    expect(
      (await f.app.inject({ method: 'DELETE', url: `${url}/acl/${target.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(204);
    const discovered = await f.app.inject({ url, headers: target.headers });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json().bot.currentVersion).toBeUndefined();
    expect(discovered.body).not.toContain(f.model.id);
    expect(await Promise.all(permissions.map((p) => permission(f, target.id, p)))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
  it.each([
    ['workspace owner', 'owner', null],
    ['workspace administrator', 'administrator', null],
    ['Bot editor', 'member', 'editor'],
    ['Bot user', 'member', 'user'],
  ] as const)(
    'denies %s every ACL management and visibility mutation without an owner grant',
    async (_name, workspaceRole, botRole) => {
      const f = await botAclFixture(cleanup),
        actor = await f.addUser(workspaceRole),
        target = await f.addUser();
      const url = `${f.path}/${f.bot.id}`;
      if (botRole)
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: `${url}/acl`,
              headers: f.headers,
              payload: { userId: actor.id, role: botRole },
            })
          ).statusCode,
        ).toBe(201);
      const snapshot = async () => ({
        acl: (
          await f.pool.query('SELECT * FROM bot_acl WHERE bot_id=$1 ORDER BY user_id', [f.bot.id])
        ).rows,
        bot: (await f.pool.query('SELECT * FROM bots WHERE id=$1', [f.bot.id])).rows,
        audit: (await f.pool.query('SELECT * FROM audit_events ORDER BY id')).rows,
      });
      const before = await snapshot();
      for (const request of [
        { method: 'GET' as const, url: `${url}/acl` },
        {
          method: 'POST' as const,
          url: `${url}/acl`,
          payload: { userId: target.id, role: 'owner' },
        },
        {
          method: 'PATCH' as const,
          url: `${url}/acl/${f.owner.user.id}`,
          payload: { role: 'user' },
        },
        { method: 'DELETE' as const, url: `${url}/acl/${f.owner.user.id}` },
        {
          method: 'PATCH' as const,
          url: `${url}/visibility`,
          payload: { visibility: 'workspace' },
        },
      ]) {
        const response = await f.app.inject({ ...request, headers: actor.headers });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: { code: 'bot_forbidden' } });
      }
      expect(await permission(f, actor.id, 'manageLifecycle')).toBe(false);
      expect(await permission(f, actor.id, 'edit')).toBe(botRole === 'editor');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('does not turn group ownership into Bot use, inspection or administration', async () => {
    const f = await botAclFixture(cleanup),
      actor = await f.addUser();
    await new GroupService(new PostgresGroupRepository(f.pool)).create(
      actor.id,
      f.owner.workspace.id,
      { name: 'Owned group' },
    );
    expect(await Promise.all(permissions.map((p) => permission(f, actor.id, p)))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      (await f.app.inject({ url: `${f.path}/${f.bot.id}/acl`, headers: actor.headers })).statusCode,
    ).toBe(403);
  });
  it('allows workspace deprovisioning of the only Bot owner without administrator takeover and honors a retained grant on rejoin', async () => {
    const f = await botAclFixture(cleanup),
      workspaceOwner = await f.addUser('owner');
    const response = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/members/${f.owner.user.id}`,
      headers: workspaceOwner.headers,
    });
    expect(response.statusCode).toBe(204);
    const session = await f.app.inject({ url: '/api/v1/me', headers: f.headers });
    expect(session.statusCode).toBe(200);
    expect(session.json().workspace).toBeNull();
    for (const headers of [f.headers, workspaceOwner.headers]) {
      expect((await f.app.inject({ url: `${f.path}/${f.bot.id}/acl`, headers })).statusCode).toBe(
        403,
      );
      expect((await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers })).statusCode).toBe(403);
    }
    await f.pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'member',NOW())",
      [f.owner.workspace.id, f.owner.user.id],
    );
    expect(
      (await f.app.inject({ url: `${f.path}/${f.bot.id}/acl`, headers: f.headers })).statusCode,
    ).toBe(200);
    const target = await f.addUser();
    const acl = `${f.path}/${f.bot.id}/acl`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: acl,
          headers: f.headers,
          payload: { userId: target.id },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await f.app.inject({ method: 'DELETE', url: `${acl}/${target.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(204);
    await f.pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
      f.owner.workspace.id,
      target.id,
    ]);
    await f.pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'member',NOW())",
      [f.owner.workspace.id, target.id],
    );
    expect(
      (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: target.headers })).statusCode,
    ).toBe(403);
  });
  it('canonicalizes all scoped UUID inputs and audits persisted Bot and target identities', async () => {
    const f = await botAclFixture(cleanup),
      target = await f.addUser();
    const url = `/api/v1/workspaces/${f.owner.workspace.id.toUpperCase()}/bots/${f.bot.id.toUpperCase()}`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${url}/acl`,
          headers: f.headers,
          payload: { userId: target.id.toUpperCase(), role: 'editor' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `${url}/acl/${target.id.toUpperCase()}`,
          headers: f.headers,
          payload: { role: 'user' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `${url}/acl/${target.id.toUpperCase()}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `${url}/visibility`,
          headers: f.headers,
          payload: { visibility: 'workspace' },
        })
      ).statusCode,
    ).toBe(200);
    const audit = (
      await f.pool.query<{
        metadata: { workspaceId: string; botId: string; targetUserId?: string };
      }>(
        "SELECT metadata FROM audit_events WHERE event_type IN ('bot.acl_granted','bot.acl_role_changed','bot.acl_revoked','bot.visibility_changed')",
      )
    ).rows;
    expect(audit).toHaveLength(4);
    for (const { metadata } of audit) {
      expect(metadata.workspaceId).toBe(f.owner.workspace.id);
      expect(metadata.botId).toBe(f.bot.id);
      if (metadata.targetUserId) expect(metadata.targetUserId).toBe(target.id);
    }
  });
  it('rejects cross-workspace targets, conflicting grants, malformed inputs and inaccessible Bot identifiers safely', async () => {
    const f = await botAclFixture(cleanup);
    const other = await new WorkspaceService(new PostgresWorkspaceRepository(f.pool)).create(
      f.owner.user.id,
      { name: 'Other workspace' },
    );
    const outsider = await f.addUser('member', other.id),
      target = await f.addUser();
    const url = `${f.path}/${f.bot.id}/acl`;
    for (const userId of [outsider.id, randomUUID()]) {
      const response = await f.app.inject({
        method: 'POST',
        url,
        headers: f.headers,
        payload: { userId },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: 'bot_acl_member_not_found' } });
    }
    for (const botId of [randomUUID(), f.bot.id]) {
      const response = await f.app.inject({
        url: `/api/v1/workspaces/${other.id}/bots/${botId}/acl`,
        headers: f.headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'bot_forbidden' } });
    }
    for (const payload of [
      { userId: target.id, role: 'admin' },
      { userId: 'invalid' },
      { userId: target.id, workspaceId: other.id },
      { userId: target.id, role: null },
    ])
      expect(
        (await f.app.inject({ method: 'POST', url, headers: f.headers, payload })).statusCode,
      ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { userId: target.id },
        })
      ).statusCode,
    ).toBe(201);
    const duplicate = await f.app.inject({
      method: 'POST',
      url,
      headers: f.headers,
      payload: { userId: target.id },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: { code: 'bot_acl_conflict' } });
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `${url}/${target.id}`,
          headers: f.headers,
          payload: { role: 'owner', userId: f.owner.user.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `${f.path}/${f.bot.id}/visibility`,
          headers: f.headers,
          payload: { visibility: 'public' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await f.app.inject({ method: 'DELETE', url: `${url}/not-a-uuid`, headers: f.headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `${url}/${target.id}`,
          headers: f.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });
  it('requires the real session and exact Origin for every mutation, and safely rejects malformed JSON', async () => {
    const f = await botAclFixture(cleanup),
      target = await f.addUser();
    const url = `${f.path}/${f.bot.id}`;
    for (const request of [
      { method: 'POST' as const, url: `${url}/acl`, payload: { userId: target.id } },
      { method: 'PATCH' as const, url: `${url}/acl/${target.id}`, payload: { role: 'user' } },
      { method: 'DELETE' as const, url: `${url}/acl/${target.id}` },
      { method: 'PATCH' as const, url: `${url}/visibility`, payload: { visibility: 'workspace' } },
    ]) {
      const anonymous = await f.app.inject({ ...request, headers: { origin: f.headers.origin } });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toEqual({ error: { code: 'authentication_required' } });
      const origin = await f.app.inject({
        ...request,
        headers: { ...f.headers, origin: 'https://untrusted.example' },
      });
      expect(origin.statusCode).toBe(403);
      expect(origin.json()).toEqual({ error: { code: 'invalid_origin' } });
    }
    expect((await f.app.inject({ url: `${url}/acl` })).statusCode).toBe(401);
    const malformed = await f.app.inject({
      method: 'POST',
      url: `${url}/acl`,
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: '{invalid',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: { code: 'invalid_bot_request' } });
  });
  it('does not expose audit/database failures and samples metadata time only after owner admission', async () => {
    let instant = new Date('2030-01-01T00:00:00Z');
    let failAudit = false;
    const f = await botAclFixture(cleanup, {
      now: () => instant,
      onAclQuery: (statement) => {
        if (statement.includes('FROM bots') && statement.includes('FOR UPDATE'))
          instant = new Date('2030-01-01T00:05:00Z');
        if (failAudit && statement.includes('INSERT INTO audit_events'))
          throw new Error('private database connection password');
      },
    });
    const target = await f.addUser();
    const grant = await f.app.inject({
      method: 'POST',
      url: `${f.path}/${f.bot.id}/acl`,
      headers: f.headers,
      payload: { userId: target.id },
    });
    expect(grant.statusCode).toBe(201);
    expect(grant.json().member.joinedAt).toBe('2030-01-01T00:05:00.000Z');
    failAudit = true;
    const response = await f.app.inject({
      method: 'PATCH',
      url: `${f.path}/${f.bot.id}/visibility`,
      headers: f.headers,
      payload: { visibility: 'workspace' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'bot_unavailable' } });
    // pg-mem cannot establish rollback; the restricted-role native suite proves atomicity.
  });
});

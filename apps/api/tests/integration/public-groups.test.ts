import { afterEach, expect, it } from 'vitest';
import { publicGroupFixture } from '../helpers/public-group-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('creates, updates, retrieves, and archives groups through groups:write', async () => {
  const f = await publicGroupFixture(cleanup);
  const headers = await f.bearer(['groups:read', 'groups:write']);
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/groups',
    headers,
    payload: { name: 'Research', description: 'Public API group', maxConcurrentRuns: 2 },
  });
  expect(created.statusCode).toBe(201);
  expect(created.headers['cache-control']).toBe('private, no-store');
  expect(created.headers['x-content-type-options']).toBe('nosniff');
  const group = created.json().group;
  expect(group).toMatchObject({
    name: 'Research',
    description: 'Public API group',
    visibility: 'private',
    role: 'owner',
    archivedAt: null,
    policy: { maxConcurrentRuns: 2 },
    defaultLead: null,
    workspaceId: f.owner.workspace.id,
  });
  const ui = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${group.id}`,
    headers: f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().group).toMatchObject({
    id: group.id,
    name: 'Research',
    description: 'Public API group',
    visibility: 'private',
    role: 'owner',
  });
  const renamed = await f.publicApp.inject({
    method: 'PATCH',
    url: `/v1/groups/${group.id}`,
    headers,
    payload: { name: 'Planning', visibility: 'workspace', maxConcurrentRuns: 6 },
  });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json().group).toMatchObject({
    name: 'Planning',
    visibility: 'workspace',
    policy: { maxConcurrentRuns: 6 },
  });
  expect(
    (
      await f.sessionApp.inject({
        url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${group.id}`,
        headers: f.headers,
      })
    ).json().group.name,
  ).toBe('Planning');
  const archived = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/groups/${group.id}/archive`,
    headers,
  });
  expect(archived.statusCode).toBe(200);
  expect(archived.json().group.archivedAt).toBeTruthy();
  const blocked = await f.publicApp.inject({
    method: 'PATCH',
    url: `/v1/groups/${group.id}`,
    headers,
    payload: { name: 'Must not rename' },
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json()).toEqual({ error: { code: 'group_archived' } });
  expect(
    (
      await f.sessionApp.inject({
        url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${group.id}`,
        headers: f.headers,
      })
    ).json().group.name,
  ).toBe('Planning');
});

it('adds and removes humans and bots, defaults history to future, and sets the default lead', async () => {
  const f = await publicGroupFixture(cleanup);
  const headers = await f.bearer(['groups:write']);
  const member = await f.addUser();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/groups',
    headers,
    payload: { name: 'Ops' },
  });
  const groupId = created.json().group.id;
  const added = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/groups/${groupId}/members`,
    headers,
    payload: { userId: member.id, role: 'admin' },
  });
  expect(added.statusCode).toBe(201);
  expect(added.json().member.user.id).toBe(member.id);
  expect(added.json().member.role).toBe('admin');
  const uiMembers = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${groupId}/members`,
    headers: f.headers,
  });
  expect(uiMembers.json().members.map((row: { user: { id: string } }) => row.user.id)).toContain(
    member.id,
  );
  const invited = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/groups/${groupId}/bots`,
    headers,
    payload: { botId: f.bot.id },
  });
  expect(invited.statusCode).toBe(201);
  expect(invited.json().grant.bot.id).toBe(f.bot.id);
  expect(invited.json().grant.history.mode).toBe('future-only');
  const other = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/groups',
    headers,
    payload: { name: 'History' },
  });
  const allHistory = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/groups/${other.json().group.id}/bots`,
    headers,
    payload: { botId: f.bot.id, historyAccess: 'all', idempotencyKey: 'invite-all' },
  });
  expect(allHistory.statusCode).toBe(201);
  expect(allHistory.json().grant.history.mode).toBe('all');
  const lead = await f.publicApp.inject({
    method: 'PATCH',
    url: `/v1/groups/${groupId}/routing`,
    headers,
    payload: { expectedRevision: 0, defaultGrantId: invited.json().grant.id },
  });
  expect(lead.statusCode).toBe(200);
  expect(lead.json().routing.defaultLead.grantId).toBe(invited.json().grant.id);
  expect(
    (
      await f.publicApp.inject({
        url: `/v1/groups/${groupId}`,
        headers: await f.bearer(['groups:read']),
      })
    ).json().group.defaultLead.grantId,
  ).toBe(invited.json().grant.id);
  const removed = await f.publicApp.inject({
    method: 'DELETE',
    url: `/v1/groups/${groupId}/members/${member.id}`,
    headers,
  });
  expect(removed.statusCode).toBe(204);
  const after = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${groupId}/members`,
    headers: f.headers,
  });
  expect(after.json().members.map((row: { user: { id: string } }) => row.user.id)).not.toContain(
    member.id,
  );
  const denied = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${groupId}`,
    headers: member.headers,
  });
  expect(denied.statusCode).toBe(403);
});

it('rejects membership changes without group-management permission and leaves membership unchanged', async () => {
  const f = await publicGroupFixture(cleanup);
  const ownerHeaders = await f.bearer(['groups:write']);
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/groups',
    headers: ownerHeaders,
    payload: { name: 'Private circle' },
  });
  const groupId = created.json().group.id;
  const outsider = await f.addUser();
  const readOnly = await f.bearer(['groups:read']);
  const memberOnly = await f.bearer(['groups:write'], outsider.id);
  const before = (
    await f.publicApp.inject({
      url: `/v1/groups/${groupId}/members`,
      headers: await f.bearer(['groups:read']),
    })
  ).json().members;
  const missingScope = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/groups/${groupId}/members`,
    headers: readOnly,
    payload: { userId: outsider.id },
  });
  expect(missingScope.statusCode).toBe(403);
  expect(missingScope.json()).toEqual({ error: { code: 'insufficient_scope' } });
  const noManage = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/groups/${groupId}/members`,
    headers: memberOnly,
    payload: { userId: outsider.id },
  });
  expect(noManage.statusCode).toBe(403);
  expect(noManage.json()).toEqual({ error: { code: 'group_forbidden' } });
  const after = (
    await f.publicApp.inject({
      url: `/v1/groups/${groupId}/members`,
      headers: await f.bearer(['groups:read']),
    })
  ).json().members;
  expect(after).toEqual(before);
});

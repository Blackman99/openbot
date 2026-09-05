import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService, GroupBotAccessError } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { ConversationService, ConversationAccessError } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { afterEach, expect, it } from 'vitest';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { lockAuthorizedBot } from '../../src/bots/postgres-bot-access.js';
import { BotAccessError } from '../../src/bots/service.js';

const cleanup: Array<() => Promise<unknown>> = [];

it('soft deletes with a fixed 30-day window, hides default lists, and lets only an owner recover the previous state', async () => {
  let now = new Date('2030-01-01T00:00:00Z');
  const f = await botAclFixture(cleanup, { now: () => now });
  const call = (action: string) =>
    f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/${action}`, headers: f.headers });
  await call('archive');
  const removed = await call('delete');
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toEqual({
    lifecycle: {
      botId: f.bot.id,
      workspaceId: f.owner.workspace.id,
      state: 'deleted',
      deletedAt: '2030-01-01T00:00:00.000Z',
      recoveryDeadline: '2030-01-31T00:00:00.000Z',
      preDeletedState: 'archived',
    },
  });
  now = new Date('2030-01-03T00:00:00Z');
  expect((await call('delete')).json()).toEqual(removed.json());
  expect((await f.app.inject({ url: f.path, headers: f.headers })).json().bots).toEqual([]);
  const recovery = await f.app.inject({ url: `${f.path}?view=deleted`, headers: f.headers });
  expect(recovery.json().bots).toMatchObject([{ id: f.bot.id, lifecycleState: 'deleted' }]);
  const retained = await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers });
  expect(retained.json().bot.currentVersion.id).toBe(f.bot.currentVersion.id);
  expect(retained.json().bot.lifecycleState).toBe('deleted');
  expect((await call('restore')).statusCode).toBe(409);
  const undone = await call('undo-delete');
  expect(undone.statusCode).toBe(200);
  expect(undone.json().lifecycle).toMatchObject({
    state: 'archived',
    deletedAt: null,
    recoveryDeadline: null,
    preDeletedState: null,
  });
  expect((await call('undo-delete')).json()).toEqual(undone.json());
  expect(
    (
      await f.pool.query(
        "SELECT event_type,metadata FROM audit_events WHERE event_type IN ('bot.soft_deleted','bot.deletion_undone') ORDER BY occurred_at",
      )
    ).rows,
  ).toEqual([
    {
      event_type: 'bot.soft_deleted',
      metadata: {
        workspaceId: f.owner.workspace.id,
        botId: f.bot.id,
        fromState: 'archived',
        toState: 'deleted',
        deletedAt: '2030-01-01T00:00:00.000Z',
        recoveryDeadline: '2030-01-31T00:00:00.000Z',
      },
    },
    {
      event_type: 'bot.deletion_undone',
      metadata: {
        workspaceId: f.owner.workspace.id,
        botId: f.bot.id,
        fromState: 'deleted',
        toState: 'archived',
      },
    },
  ]);
  expect((await f.pool.query('SELECT id FROM bots WHERE id=$1', [f.bot.id])).rows).toHaveLength(1);
  expect(
    (await f.pool.query('SELECT id FROM bot_versions WHERE bot_id=$1', [f.bot.id])).rows,
  ).toEqual([{ id: f.bot.currentVersion.id }]);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('restores archived Bots only after current enabled exact-model admission and audits effective changes', async () => {
  const f = await botAclFixture(cleanup);
  const call = (action: string) =>
    f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/${action}`, headers: f.headers });
  expect((await call('archive')).statusCode).toBe(200);
  const disabled = await f.providers.disable(f.owner.user.id, f.model.id);
  expect(disabled.enabled).toBe(false);
  const denied = await call('restore');
  expect(denied.statusCode).toBe(400);
  expect(denied.json()).toEqual({ error: { code: 'bot_model_unavailable', reason: 'disabled' } });
  await f.pool.query('UPDATE personal_model_connections SET metadata=$2::jsonb WHERE id=$1', [
    f.model.id,
    JSON.stringify({ ...disabled, enabled: true }),
  ]);
  const restored = await call('restore');
  expect(restored.statusCode).toBe(200);
  expect(restored.json().lifecycle.state).toBe('active');
  expect((await call('restore')).json()).toEqual(restored.json());
  expect(
    (await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='bot.restored'")).rows,
  ).toEqual([
    {
      metadata: {
        workspaceId: f.owner.workspace.id,
        botId: f.bot.id,
        fromState: 'archived',
        toState: 'active',
      },
    },
  ]);
});

it('archives through the owner API, denies fresh use and retains stable configuration and one audit', async () => {
  const f = await botAclFixture(cleanup);
  const response = await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/archive`,
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    lifecycle: {
      botId: f.bot.id,
      workspaceId: f.owner.workspace.id,
      state: 'archived',
      deletedAt: null,
      recoveryDeadline: null,
      preDeletedState: null,
    },
  });
  const connection = await f.pool.connect();
  try {
    await expect(
      lockAuthorizedBot(
        connection,
        {
          actorUserId: f.owner.user.id,
          workspaceId: f.owner.workspace.id,
          botId: f.bot.id,
        },
        'use',
      ),
    ).rejects.toBeInstanceOf(BotAccessError);
  } finally {
    connection.release();
  }
  const detail = await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers });
  expect(detail.json().bot.currentVersion.id).toBe(f.bot.currentVersion.id);
  expect(detail.json().bot.lifecycleState).toBe('archived');
  const repeated = await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/archive`,
    headers: f.headers,
  });
  expect(repeated.json()).toEqual(response.json());
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
});

it.each(['owner', 'administrator', 'editor', 'user', 'discovery'] as const)(
  'denies every lifecycle command to %s without a current Bot owner grant',
  async (role) => {
    const f = await botAclFixture(cleanup);
    const other = await f.addUser(role === 'owner' || role === 'administrator' ? role : 'member');
    if (role === 'editor' || role === 'user')
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/${f.bot.id}/acl`,
        headers: f.headers,
        payload: { userId: other.id, role },
      });
    await f.app.inject({
      method: 'PATCH',
      url: `${f.path}/${f.bot.id}/visibility`,
      headers: f.headers,
      payload: { visibility: 'workspace' },
    });
    for (const action of ['archive', 'restore', 'delete', 'undo-delete']) {
      const response = await f.app.inject({
        method: 'POST',
        url: `${f.path}/${f.bot.id}/${action}`,
        headers: other.headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'bot_forbidden' } });
    }
    await f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/delete`, headers: f.headers });
    expect(
      (await f.app.inject({ url: `${f.path}?view=deleted`, headers: other.headers })).json().bots,
    ).toEqual([]);
    expect(
      (await f.app.inject({ url: `${f.path}/${f.bot.id}/lifecycle`, headers: other.headers }))
        .statusCode,
    ).toBe(403);
  },
);

it('samples expiry after locked admission, rejects at the deadline and preserves the expired identity without physical erasure', async () => {
  let now = new Date('2030-01-01T00:00:00Z');
  const f = await botAclFixture(cleanup, { now: () => now });
  const call = (action: string) =>
    f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/${action}`, headers: f.headers });
  const deleted = await call('delete');
  now = new Date('2030-01-31T00:00:00Z');
  expect((await call('undo-delete')).json()).toEqual({ error: { code: 'bot_recovery_expired' } });
  expect((await call('delete')).json()).toEqual(deleted.json());
  expect(
    (await f.app.inject({ url: `${f.path}/${f.bot.id}/lifecycle`, headers: f.headers })).json(),
  ).toEqual(deleted.json());
  expect(
    (await f.pool.query('SELECT id FROM bot_versions WHERE bot_id=$1', [f.bot.id])).rows,
  ).toEqual([{ id: f.bot.currentVersion.id }]);
  expect(
    (await f.pool.query("SELECT id FROM audit_events WHERE event_type='bot.deletion_undone'")).rows,
  ).toEqual([]);
});

it('requires fresh actual-owner provider admission for undo-to-active and ignores provider availability when undoing to archived', async () => {
  const f = await botAclFixture(cleanup);
  const call = (action: string, headers = f.headers) =>
    f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/${action}`, headers });
  const second = await f.addUser();
  await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/acl`,
    headers: f.headers,
    payload: { userId: second.id, role: 'owner' },
  });
  await call('delete');
  const denied = await call('undo-delete', second.headers);
  expect(denied.statusCode).toBe(400);
  expect(denied.json()).toEqual({
    error: { code: 'bot_model_unavailable', reason: 'not-accessible' },
  });
  expect((await call('undo-delete')).json().lifecycle.state).toBe('active');
  await call('archive');
  await call('delete');
  await f.providers.disable(f.owner.user.id, f.model.id);
  expect((await call('undo-delete', second.headers)).json().lifecycle.state).toBe('archived');
  expect((await call('restore', second.headers)).statusCode).toBe(400);
});

it('denies stale workspace ownership, exact-Origin mismatches, bodies, malformed JSON and guessed scoped IDs', async () => {
  const f = await botAclFixture(cleanup);
  for (const action of ['archive', 'restore', 'delete', 'undo-delete']) {
    const url = `${f.path}/${f.bot.id}/${action}`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { ...f.headers, origin: 'https://evil.invalid' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.app.inject({ method: 'POST', url, headers: { origin: f.headers.origin } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { state: 'active' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { ...f.headers, 'content-type': 'application/json' },
          payload: '{secret',
        })
      ).statusCode,
    ).toBe(400);
  }
  await f.pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
    f.owner.workspace.id,
    f.owner.user.id,
  ]);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/${f.bot.id}/archive`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(403);
});

it('keeps historical group grants and stable deleted identity while denying indirect use and new invitations', async () => {
  const f = await botAclFixture(cleanup);
  const actor = f.owner.user.id,
    workspace = f.owner.workspace.id;
  const group = await new GroupService(new PostgresGroupRepository(f.pool)).create(
    actor,
    workspace,
    { name: 'History group' },
  );
  const grants = new GroupBotService(new PostgresGroupBotRepository(f.pool));
  const grant = await grants.invite(actor, workspace, group.id, {
    botId: f.bot.id,
    idempotencyKey: 'first-invitation',
  });
  await f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/archive`, headers: f.headers });
  await expect(grants.context(actor, workspace, group.id, grant.id, {})).rejects.toBeInstanceOf(
    GroupBotAccessError,
  );
  await expect(
    grants.invite(actor, workspace, group.id, {
      botId: f.bot.id,
      idempotencyKey: 'new-invitation',
    }),
  ).rejects.toBeInstanceOf(GroupBotAccessError);
  expect((await grants.list(actor, workspace, group.id)).activeCount).toBe(1);
  expect((await grants.list(actor, workspace, group.id)).grants[0]?.closed).toBeNull();
  await f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/delete`, headers: f.headers });
  expect((await grants.list(actor, workspace, group.id)).grants[0]?.bot).toMatchObject({
    id: f.bot.id,
    lifecycleState: 'deleted',
  });
  expect(
    (await f.pool.query('SELECT id FROM group_bot_grants WHERE id=$1', [grant.id])).rows,
  ).toEqual([{ id: grant.id }]);
});

it('keeps existing direct conversation history but denies creating a conversation or appending new work for archived Bots', async () => {
  const f = await botAclFixture(cleanup);
  const actor = f.owner.user.id,
    workspace = f.owner.workspace.id;
  const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
  const subject = { kind: 'direct-bot', id: f.bot.id };
  const existing = await conversations.open(actor, workspace, { subject });
  await conversations.append(actor, workspace, existing.id, {
    body: 'Retained message',
    idempotencyKey: 'original-message',
  });
  const second = await f.addUser();
  await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/acl`,
    headers: f.headers,
    payload: { userId: second.id, role: 'user' },
  });
  await f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/archive`, headers: f.headers });
  await expect(conversations.open(second.id, workspace, { subject })).rejects.toBeInstanceOf(
    ConversationAccessError,
  );
  await expect(
    conversations.append(actor, workspace, existing.id, {
      body: 'Must not append',
      idempotencyKey: 'new-message',
    }),
  ).rejects.toBeInstanceOf(ConversationAccessError);
  expect((await conversations.get(actor, workspace, existing.id, {})).messages[0]?.body).toBe(
    'Retained message',
  );
  expect((await conversations.open(actor, workspace, { subject })).id).toBe(existing.id);
  await f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/delete`, headers: f.headers });
  const retained = await conversations.get(actor, workspace, existing.id, {});
  expect(retained).toMatchObject({
    conversation: {
      id: existing.id,
      subject: { kind: 'direct-bot', id: f.bot.id },
      botLifecycleState: 'deleted',
    },
    canWrite: false,
    messages: [{ body: 'Retained message', canEdit: false, canDelete: false, canAudit: true }],
  });
});

it('checks the recovery deadline after waiting for current provider admission', async () => {
  let now = new Date('2030-01-01T00:00:00Z'),
    crossDeadline = false;
  const f = await botAclFixture(cleanup, {
    now: () => now,
    onAclQuery: (statement) => {
      if (
        crossDeadline &&
        statement.startsWith('SELECT metadata,revision,policy FROM personal_model_connections')
      )
        now = new Date('2030-01-31T00:00:00Z');
    },
  });
  await f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/delete`, headers: f.headers });
  now = new Date('2030-01-30T23:59:59Z');
  crossDeadline = true;
  const response = await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/undo-delete`,
    headers: f.headers,
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: { code: 'bot_recovery_expired' } });
});

it('keeps configuration restoration independent from archive and deletion and retains every immutable version', async () => {
  const { BotVersionService } = await import('../../src/bots/version-service.js');
  const f = await botAclFixture(cleanup);
  const versions = new BotVersionService(f.pool, {
    read: async () => {
      throw new Error('No avatar I/O expected');
    },
  });
  const access = {
    actorUserId: f.owner.user.id,
    workspaceId: f.owner.workspace.id,
    botId: f.bot.id,
  };
  let pointer = f.bot.currentVersion.id;
  for (const [action, state] of [
    ['archive', 'archived'],
    ['delete', 'deleted'],
  ] as const) {
    await f.app.inject({
      method: 'POST',
      url: `${f.path}/${f.bot.id}/${action}`,
      headers: f.headers,
    });
    const restored = await versions.restore(access, {
      expectedCurrentVersionId: pointer,
      sourceVersionId: f.bot.currentVersion.id,
    });
    expect(restored.id).not.toBe(pointer);
    pointer = restored.id;
    expect(
      (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers })).json().bot
        .lifecycleState,
    ).toBe(state);
  }
  expect((await versions.list(access, {})).versions.map((version) => version.number)).toEqual([
    3, 2, 1,
  ]);
});

it.each(['binding-changed', 'capability-unavailable'] as const)(
  'requires current %s validation before archived-to-active or undo-to-active',
  async (reason) => {
    const f = await botAclFixture(cleanup);
    const call = (action: string) =>
      f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/${action}`, headers: f.headers });
    await call('archive');
    if (reason === 'binding-changed')
      await f.pool.query('UPDATE personal_model_connections SET metadata=$2::jsonb WHERE id=$1', [
        f.model.id,
        JSON.stringify({ ...f.model, modelId: 'changed-model' }),
      ]);
    else
      await f.pool.query("UPDATE personal_model_connections SET policy='{}'::jsonb WHERE id=$1", [
        f.model.id,
      ]);
    const result = await call('restore');
    expect(result.statusCode).toBe(400);
    expect(result.json()).toEqual({ error: { code: 'bot_model_unavailable', reason } });
    expect(
      (await f.app.inject({ url: `${f.path}/${f.bot.id}/lifecycle`, headers: f.headers })).json()
        .lifecycle.state,
    ).toBe('archived');
  },
);

it('integrates the strict lifecycle BFF with actual API transitions, recovery list and historical detail', async () => {
  const { BotLifecycleApiClient } =
    await import('../../../web/src/lib/server/bot-lifecycle-api.js');
  const { BotApiClient } = await import('../../../web/src/lib/server/bot-api.js');
  const f = await botAclFixture(cleanup);
  const request: typeof fetch = async (url, init) => {
    const response = await f.app.inject({
      method: init?.method === 'POST' ? 'POST' : 'GET',
      url: new URL(String(url)).pathname + new URL(String(url)).search,
      headers: Object.fromEntries(new Headers(init?.headers)),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  const session = f.headers.cookie.slice('openbot_session='.length),
    workspace = f.owner.workspace.id;
  const lifecycle = new BotLifecycleApiClient(request, 'http://api', 'http://localhost:3000');
  const bots = new BotApiClient(request, 'http://api', 'http://localhost:3000');
  for (const [action, state] of [
    ['archive', 'archived'],
    ['restore', 'active'],
    ['delete', 'deleted'],
  ] as const)
    expect(await lifecycle.change(session, workspace, f.bot.id, action)).toMatchObject({
      status: 'available',
      value: { state },
    });
  expect(await bots.list(session, workspace)).toEqual({ status: 'available', value: [] });
  expect(await bots.list(session, workspace, 'usable')).toEqual({ status: 'available', value: [] });
  expect(await bots.list(session, workspace, 'deleted')).toMatchObject({
    status: 'available',
    value: [{ id: f.bot.id, lifecycleState: 'deleted' }],
  });
  expect(await bots.get(session, workspace, f.bot.id)).toMatchObject({
    status: 'available',
    value: {
      id: f.bot.id,
      lifecycleState: 'deleted',
      currentVersion: { id: f.bot.currentVersion.id },
    },
  });
  expect(await lifecycle.change(session, workspace, f.bot.id, 'undo-delete')).toMatchObject({
    status: 'available',
    value: { state: 'active' },
  });
});

it('hides deleted discovery-only detail while preserving current direct users historical access', async () => {
  const f = await botAclFixture(cleanup);
  const reader = await f.addUser(),
    discovery = await f.addUser('administrator');
  await f.app.inject({
    method: 'PATCH',
    url: `${f.path}/${f.bot.id}/visibility`,
    headers: f.headers,
    payload: { visibility: 'workspace' },
  });
  await f.app.inject({
    method: 'POST',
    url: `${f.path}/${f.bot.id}/acl`,
    headers: f.headers,
    payload: { userId: reader.id, role: 'user' },
  });
  await f.app.inject({ method: 'POST', url: `${f.path}/${f.bot.id}/delete`, headers: f.headers });
  expect(
    (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: discovery.headers })).statusCode,
  ).toBe(403);
  expect(
    (await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: reader.headers })).json().bot,
  ).toMatchObject({
    id: f.bot.id,
    lifecycleState: 'deleted',
    currentVersion: { id: f.bot.currentVersion.id },
  });
});

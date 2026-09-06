import { afterEach, expect, it } from 'vitest';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { GroupService, GroupAccessError } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupRoutingService, RoutingSettingConflictError } from '../../src/routing/service.js';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { BotModelError, BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { admitGroupLead } from '../../src/routing/admission.js';
import { TaskService, TaskConflictError, TaskAccessError } from '../../src/tasks/service.js';
import { BotLifecycleService } from '../../src/bots/lifecycle-service.js';
import { ProviderError } from '../../src/providers/url-policy.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const f = await botAclFixture(cleanup);
  const groups = new GroupService(new PostgresGroupRepository(f.pool));
  const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
    name: 'Routing group',
  });
  const grants = new GroupBotService(new PostgresGroupBotRepository(f.pool));
  const grant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
    botId: f.bot.id,
    idempotencyKey: 'routing-grant',
  });
  return { ...f, groups, group, grants, grant, routing: new GroupRoutingService(f.pool) };
}

it('starts with an empty default and allows only current group members to inspect it', async () => {
  const f = await fixture();
  expect(await f.routing.get(f.owner.user.id, f.owner.workspace.id, f.group.id)).toEqual({
    groupId: f.group.id,
    revision: 0,
    defaultLead: null,
    canManage: true,
  });
  const outsider = await f.addUser('administrator');
  await expect(f.routing.get(outsider.id, f.owner.workspace.id, f.group.id)).rejects.toBeInstanceOf(
    GroupAccessError,
  );
  await f.groups.addMember(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    userId: outsider.id,
    role: 'member',
  });
  expect(await f.routing.get(outsider.id, f.owner.workspace.id, f.group.id)).toMatchObject({
    canManage: false,
    defaultLead: null,
  });
});

it('changes the exact default grant with current management permission, CAS and one safe audit', async () => {
  const f = await fixture();
  const value = await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    expectedRevision: 0,
    defaultGrantId: f.grant.id,
  });
  expect(value).toMatchObject({
    revision: 1,
    defaultLead: { grantId: f.grant.id, bot: { id: f.bot.id }, closed: false },
  });
  expect(JSON.stringify(value)).not.toMatch(/Instructions|modelBinding|never-return/);
  await expect(
    f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      expectedRevision: 0,
      defaultGrantId: null,
    }),
  ).rejects.toBeInstanceOf(RoutingSettingConflictError);
  expect(
    await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      expectedRevision: 1,
      defaultGrantId: f.grant.id,
    }),
  ).toEqual(value);
  const audits = (
    await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='group.routing_updated'")
  ).rows;
  expect(audits).toEqual([
    {
      metadata: {
        workspaceId: f.owner.workspace.id,
        groupId: f.group.id,
        revision: 1,
        previousDefaultGrantId: null,
        defaultGrantId: f.grant.id,
      },
    },
  ]);
  const member = await f.addUser();
  await f.groups.addMember(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    userId: member.id,
    role: 'member',
  });
  await expect(
    f.routing.update(member.id, f.owner.workspace.id, f.group.id, {
      expectedRevision: 1,
      defaultGrantId: null,
    }),
  ).rejects.toBeInstanceOf(GroupAccessError);
  expect(
    await new GroupRoutingService(f.pool).get(member.id, f.owner.workspace.id, f.group.id),
  ).toMatchObject({ revision: 1, defaultLead: { grantId: f.grant.id }, canManage: false });
});

it('exposes authenticated private routing settings over HTTP with safe mutation errors', async () => {
  const f = await fixture();
  const app = buildApp({
    auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
    groupRouting: f.routing,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  const url = `/api/v1/workspaces/${f.owner.workspace.id}/groups/${f.group.id}/routing`;
  const first = await app.inject({ method: 'GET', url, headers: f.headers });
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('private, no-store');
  expect(first.json()).toMatchObject({ routing: { revision: 0, defaultLead: null } });
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  const payload = { expectedRevision: 0, defaultGrantId: f.grant.id };
  const deniedOrigin = await app.inject({
    method: 'PATCH',
    url,
    headers: { ...f.headers, origin: 'https://elsewhere.example' },
    payload,
  });
  expect(deniedOrigin.statusCode).toBe(403);
  const invalid = await app.inject({
    method: 'PATCH',
    url,
    headers: f.headers,
    payload: { ...payload, role: 'owner' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ error: { code: 'invalid_routing_request' } });
  const updated = await app.inject({ method: 'PATCH', url, headers: f.headers, payload });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({
    routing: { revision: 1, defaultLead: { grantId: f.grant.id } },
  });
  const stale = await app.inject({ method: 'PATCH', url, headers: f.headers, payload });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toEqual({ error: { code: 'routing_revision_conflict' } });
});

it('allows clearing an unavailable default while preserving current provider admission for setting it', async () => {
  const f = await fixture();
  await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    expectedRevision: 0,
    defaultGrantId: f.grant.id,
  });
  await f.providers.disable(f.owner.user.id, f.model.id);
  await expect(
    f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      expectedRevision: 1,
      defaultGrantId: f.grant.id,
    }),
  ).rejects.toBeInstanceOf(BotModelError);
  expect(
    await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      expectedRevision: 1,
      defaultGrantId: null,
    }),
  ).toMatchObject({ revision: 2, defaultLead: null });
});

it('retains the closed default identity for inspection without rebinding to a replacement invitation', async () => {
  const f = await fixture();
  await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    expectedRevision: 0,
    defaultGrantId: f.grant.id,
  });
  await f.grants.remove(f.owner.user.id, f.owner.workspace.id, f.group.id, f.grant.id, {
    idempotencyKey: 'remove-default',
  });
  const replacement = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    botId: f.bot.id,
    idempotencyKey: 'replace-default',
  });
  expect(replacement.id).not.toBe(f.grant.id);
  expect(await f.routing.get(f.owner.user.id, f.owner.workspace.id, f.group.id)).toMatchObject({
    defaultLead: { grantId: f.grant.id, closed: true },
  });
});

it('selects one currently admitted group Lead using mention, default and local evidence in that order', async () => {
  const f = await fixture();
  const coder = await new BotService(new PostgresBotRepository(f.pool)).create(
    f.owner.user.id,
    f.owner.workspace.id,
    {
      name: 'Coder',
      roleDescription: 'TypeScript and database specialist',
      instructions: 'Private coding instructions',
      modelBinding: {
        scope: { kind: 'personal', id: f.owner.user.id },
        connectionId: f.model.id,
        modelId: f.model.modelId,
      },
    },
  );
  const coderGrant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    botId: coder.id,
    idempotencyKey: 'coder-invite',
  });
  const access = {
    actorUserId: f.owner.user.id,
    workspaceId: f.owner.workspace.id,
    groupId: f.group.id,
    conversationId: f.grant.conversationId,
  };
  async function select(groupGrantId?: string) {
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await admitGroupLead(connection, access, {
        body: 'TypeScript database',
        ...(groupGrantId ? { groupGrantId } : {}),
      });
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  const local = await select();
  expect(local.target.groupGrantId).toBe(coderGrant.id);
  expect(local.decision.reason).toBe('local-match');
  expect(local.decision.candidates).toHaveLength(2);
  expect(JSON.stringify(local.decision)).not.toMatch(/instructions|modelBinding|Private coding/);
  await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    expectedRevision: 0,
    defaultGrantId: f.grant.id,
  });
  expect((await select()).decision).toMatchObject({
    reason: 'default',
    lead: { grantId: f.grant.id },
  });
  expect((await select(coderGrant.id)).decision).toMatchObject({
    reason: 'mention',
    lead: { grantId: coderGrant.id },
  });
});

it('atomically submits an automatic group turn and replays its original decision after the default changes', async () => {
  const f = await fixture();
  const tasks = new TaskService(f.pool);
  const command = { idempotencyKey: 'automatic-turn', body: 'Researcher discovery' };
  const task = await tasks.submit(
    f.owner.user.id,
    f.owner.workspace.id,
    f.grant.conversationId,
    command,
  );
  expect(task).toMatchObject({
    groupGrantId: f.grant.id,
    bot: { id: f.bot.id, versionId: f.bot.currentVersion.id },
    routing: { algorithm: 'local-terms-v1', reason: 'local-match' },
  });
  const evidence = await tasks.routing(
    f.owner.user.id,
    f.owner.workspace.id,
    f.grant.conversationId,
    task.id,
  );
  expect(evidence).toMatchObject({
    algorithm: 'local-terms-v1',
    reason: 'local-match',
    lead: { botId: f.bot.id, grantId: f.grant.id, versionId: f.bot.currentVersion.id },
    candidates: [{ botId: f.bot.id, matchedTerms: ['discovery', 'researcher'] }],
  });
  expect(JSON.stringify(evidence)).not.toMatch(/instructions|modelBinding|never-return/);
  await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    expectedRevision: 0,
    defaultGrantId: f.grant.id,
  });
  const replay = await new TaskService(f.pool).submit(
    f.owner.user.id,
    f.owner.workspace.id,
    f.grant.conversationId,
    command,
  );
  expect(replay).toEqual(task);
  expect(
    await tasks.routing(f.owner.user.id, f.owner.workspace.id, f.grant.conversationId, task.id),
  ).toEqual(evidence);
  await expect(
    tasks.submit(f.owner.user.id, f.owner.workspace.id, f.grant.conversationId, {
      ...command,
      groupGrantId: f.grant.id,
    }),
  ).rejects.toBeInstanceOf(TaskConflictError);
  expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
  expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(1);
  expect((await f.pool.query('SELECT task_id FROM task_routing_decisions')).rows).toHaveLength(1);
  expect(
    (await f.pool.query("SELECT id FROM conversation_events WHERE event_type='message.created'"))
      .rows,
  ).toHaveLength(1);
  expect(
    (await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='task.routed'")).rows,
  ).toEqual([
    {
      metadata: {
        workspaceId: f.owner.workspace.id,
        conversationId: f.grant.conversationId,
        taskId: task.id,
        botId: f.bot.id,
        botVersionId: f.bot.currentVersion.id,
        grantId: f.grant.id,
        reason: 'local-match',
        algorithm: 'local-terms-v1',
      },
    },
  ]);
});

it('uses the actual group member model rights without lending the grantor personal connection or direct Bot ACL', async () => {
  const f = await fixture();
  const member = await f.addUser();
  await f.groups.addMember(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    userId: member.id,
    role: 'member',
  });
  const shared = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
    name: 'Shared Basic',
    protocol: 'openai-chat',
    baseUrl: 'https://models.example/v1',
    modelId: 'shared-model',
    apiKey: 'shared-private-secret',
    headers: {},
  });
  const bot = await new BotService(new PostgresBotRepository(f.pool)).create(
    f.owner.user.id,
    f.owner.workspace.id,
    {
      name: 'Shared helper',
      roleDescription: 'Group assistant',
      instructions: 'Only granted group context',
      modelBinding: {
        scope: { kind: 'workspace', id: f.owner.workspace.id },
        connectionId: shared.id,
        modelId: shared.modelId,
      },
    },
  );
  const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    botId: bot.id,
    idempotencyKey: 'shared-invite',
  });
  await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    expectedRevision: 0,
    defaultGrantId: f.grant.id,
  });
  // The group execution grant still does not grant direct configuration access.
  expect(
    (await f.app.inject({ method: 'GET', url: `${f.path}/${bot.id}`, headers: member.headers }))
      .statusCode,
  ).toBe(403);
  const tasks = new TaskService(f.pool);
  const task = await tasks.submit(member.id, f.owner.workspace.id, f.grant.conversationId, {
    idempotencyKey: 'member-auto',
    body: 'Researcher discovery',
  });
  expect(task).toMatchObject({
    groupGrantId: grant.id,
    routing: { reason: 'local-match' },
    executionUser: { id: member.id },
  });
  expect(
    (await tasks.routing(member.id, f.owner.workspace.id, f.grant.conversationId, task.id))
      .candidates,
  ).toHaveLength(1);
  await expect(
    tasks.submit(member.id, f.owner.workspace.id, f.grant.conversationId, {
      idempotencyKey: 'member-explicit-private',
      body: 'Same request',
      groupGrantId: f.grant.id,
    }),
  ).rejects.toBeInstanceOf(ProviderError);
  expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
});

it.each(['removed', 'disabled', 'archived', 'incompatible'] as const)(
  'excludes a %s default and retains its historical routing evidence',
  async (state) => {
    const f = await fixture();
    const tasks = new TaskService(f.pool);
    await f.routing.update(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      expectedRevision: 0,
      defaultGrantId: f.grant.id,
    });
    const command = { idempotencyKey: 'before-unavailable', body: 'Researcher' };
    const original = await tasks.submit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.grant.conversationId,
      command,
    );
    const evidence = await tasks.routing(
      f.owner.user.id,
      f.owner.workspace.id,
      f.grant.conversationId,
      original.id,
    );
    if (state === 'removed')
      await f.grants.remove(f.owner.user.id, f.owner.workspace.id, f.group.id, f.grant.id, {
        idempotencyKey: 'remove-unavailable',
      });
    else if (state === 'disabled') await f.providers.disable(f.owner.user.id, f.model.id);
    else if (state === 'archived')
      await new BotLifecycleService(f.pool).archive(
        f.owner.user.id,
        f.owner.workspace.id,
        f.bot.id,
      );
    else
      await f.providers.override(f.owner.user.id, f.model.id, {
        expectedRevision: (await f.providers.capabilities(f.owner.user.id, f.model.id)).revision,
        capability: 'streaming',
        value: false,
        rationale: 'Streaming is unavailable',
      });
    await expect(
      tasks.submit(f.owner.user.id, f.owner.workspace.id, f.grant.conversationId, {
        idempotencyKey: 'after-unavailable',
        body: 'Researcher',
      }),
    ).rejects.toMatchObject({ code: 'no_eligible_bot' });
    await expect(
      tasks.submit(f.owner.user.id, f.owner.workspace.id, f.grant.conversationId, {
        idempotencyKey: 'explicit-unavailable',
        body: 'Researcher',
        groupGrantId: f.grant.id,
      }),
    ).rejects.toBeInstanceOf(
      state === 'disabled' || state === 'incompatible' ? ProviderError : TaskAccessError,
    );
    await expect(
      tasks.submit(f.owner.user.id, f.owner.workspace.id, f.grant.conversationId, command),
    ).rejects.toBeInstanceOf(
      state === 'disabled' || state === 'incompatible' ? ProviderError : TaskAccessError,
    );
    expect(
      await tasks.routing(
        f.owner.user.id,
        f.owner.workspace.id,
        f.grant.conversationId,
        original.id,
      ),
    ).toEqual(evidence);
    expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
  },
);

it('serves bounded routing receipts over the private Task API and fails unavailable routing without a trigger', async () => {
  const f = await fixture();
  const tasks = new TaskService(f.pool);
  const app = buildApp({
    auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
    tasks,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  const base = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.grant.conversationId}/tasks`;
  const sent = await app.inject({
    method: 'POST',
    url: base,
    headers: f.headers,
    payload: { idempotencyKey: 'http-auto', body: 'Researcher' },
  });
  expect(sent.statusCode).toBe(202);
  expect(sent.json().task.routing).toEqual({ algorithm: 'local-terms-v1', reason: 'local-match' });
  const { TaskApiClient } = await import('../../../web/src/lib/server/task-api.js');
  const request: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const response = await app.inject({
      method: init?.method === 'POST' ? 'POST' : 'GET',
      url: target.pathname + target.search,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new TaskApiClient(request, 'http://api', 'http://localhost:3000');
  const session = f.headers.cookie.slice('openbot_session='.length);
  expect(
    await client.submit(session, f.owner.workspace.id, f.grant.conversationId, {
      idempotencyKey: 'http-auto',
      body: 'Researcher',
    }),
  ).toEqual({ status: 'available', value: sent.json().task });
  expect(
    await client.get(session, f.owner.workspace.id, f.grant.conversationId, sent.json().task.id),
  ).toEqual({ status: 'available', value: sent.json().task });

  const path = `${base}/${sent.json().task.id}/routing`;
  const read = await app.inject({ method: 'GET', url: path, headers: f.headers });
  expect(read.statusCode).toBe(200);
  expect(read.headers['cache-control']).toBe('private, no-store');
  expect(read.json().routing.lead).toMatchObject({ botId: f.bot.id });
  const { readTaskRoutingDecision } = await import('../../../web/src/lib/server/task-routing.js');
  expect(
    await readTaskRoutingDecision(
      request,
      session,
      f.owner.workspace.id,
      f.grant.conversationId,
      sent.json().task,
    ),
  ).toEqual({ status: 'available', value: read.json().routing });
  expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
  const outsider = await f.addUser('administrator');
  expect(
    (await app.inject({ method: 'GET', url: path, headers: outsider.headers })).statusCode,
  ).toBe(403);
  const query = await app.inject({
    method: 'GET',
    url: `${path}?include=private`,
    headers: f.headers,
  });
  expect(query.statusCode).toBe(400);
  await f.providers.disable(f.owner.user.id, f.model.id);
  const denied = await app.inject({
    method: 'POST',
    url: base,
    headers: f.headers,
    payload: { idempotencyKey: 'http-unavailable', body: 'Researcher' },
  });
  expect(denied.statusCode).toBe(409);
  expect(denied.json()).toEqual({ error: { code: 'no_eligible_bot' } });
  const explicit = await app.inject({
    method: 'POST',
    url: base,
    headers: f.headers,
    payload: {
      idempotencyKey: 'http-explicit-unavailable',
      body: 'Researcher',
      groupGrantId: f.grant.id,
    },
  });
  expect(explicit.statusCode).toBe(409);
  expect(explicit.json()).toEqual({ error: { code: 'task_model_unavailable' } });
  expect((await f.pool.query('SELECT id FROM tasks')).rows).toHaveLength(1);
});

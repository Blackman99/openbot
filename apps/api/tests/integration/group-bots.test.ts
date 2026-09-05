import { GroupBotApiClient } from '../../../web/src/lib/server/group-bot-api.js';
import { BotAvatarService } from '../../src/bots/avatar-service.js';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';

describe('group Bot grants and history', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  async function fixture() {
    const f = await botAclFixture(cleanup);
    const group = await new GroupService(new PostgresGroupRepository(f.pool)).create(
      f.owner.user.id,
      f.owner.workspace.id,
      { name: 'Research group' },
    );
    const app = buildApp({
      auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
      avatars: new BotAvatarService(f.pool, {
        identity: 'group-bot-forbidden-io',
        save: async () => {
          throw new Error('Unexpected object write');
        },
        read: async () => {
          throw new Error('Unexpected object read');
        },
        delete: async () => {
          throw new Error('Unexpected object removal');
        },
      }),
      groupBots: new GroupBotService(new PostgresGroupBotRepository(f.pool)),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    return {
      ...f,
      directApp: f.app,
      app,
      group,
      base: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${group.id}/bots`,
    };
  }
  it('rejects malformed JSON as an input error without exposing parser diagnostics', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: f.base,
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: '{broken-secret',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_group_bot_request' } });
    expect((await f.pool.query('SELECT id FROM group_bot_grants')).rows).toHaveLength(0);
  });
  it('keeps group management, context use, direct Bot configuration and avatar edits independent', async () => {
    const f = await fixture();
    const manager = await f.addUser(),
      member = await f.addUser(),
      ungrantedManager = await f.addUser();
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    for (const [person, role] of [
      [manager, 'admin'],
      [member, 'member'],
      [ungrantedManager, 'admin'],
    ] as const)
      await groups.addMember(f.owner.user.id, f.owner.workspace.id, f.group.id, {
        userId: person.id,
        role,
      });
    await f.directApp.inject({
      method: 'POST',
      url: `${f.path}/${f.bot.id}/acl`,
      headers: f.headers,
      payload: { userId: manager.id, role: 'user' },
    });
    const command = { botId: f.bot.id, idempotencyKey: 'manager-invite' };
    const invited = await f.app.inject({
      method: 'POST',
      url: f.base,
      headers: manager.headers,
      payload: command,
    });
    expect(invited.statusCode).toBe(200);
    const grant = invited.json().grant;
    for (const person of [member, ungrantedManager]) {
      const list = await f.app.inject({ url: f.base, headers: person.headers });
      expect(list.json().grants[0].bot.canInspect).toBe(false);
      expect(
        (await f.app.inject({ url: `${f.base}/${grant.id}/context`, headers: person.headers }))
          .statusCode,
      ).toBe(200);
      expect(
        (await f.directApp.inject({ url: `${f.path}/${f.bot.id}`, headers: person.headers }))
          .statusCode,
      ).toBe(403);
      expect(
        (await f.app.inject({ url: `${f.path}/${f.bot.id}/avatar`, headers: person.headers }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: f.base,
            headers: person.headers,
            payload: command,
          })
        ).statusCode,
      ).toBe(403);
    }
    for (const person of [manager, ungrantedManager])
      expect(
        (
          await f.app.inject({
            method: 'DELETE',
            url: `${f.path}/${f.bot.id}/avatar?expectedCurrentVersionId=${f.bot.currentVersion.id}`,
            headers: person.headers,
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (await f.pool.query('SELECT id FROM bot_versions WHERE bot_id=$1', [f.bot.id])).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.pool.query('SELECT role FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
          f.bot.id,
          manager.id,
        ])
      ).rows,
    ).toEqual([{ role: 'user' }]);
    await groups.changeRole(f.owner.user.id, f.owner.workspace.id, f.group.id, manager.id, {
      role: 'member',
    });
    expect(
      (await f.app.inject({ url: `${f.base}/${grant.id}/context`, headers: member.headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.base}/${grant.id}/remove`,
          headers: ungrantedManager.headers,
          payload: { idempotencyKey: 'remove-without-direct-bot' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.app.inject({ url: `${f.base}/${grant.id}/context`, headers: member.headers }))
        .statusCode,
    ).toBe(403);
  });
  it('uses the strict Web client over actual HTTP for canonical IDs, replay, safe context and fixed-grant removal', async () => {
    const f = await fixture();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new GroupBotApiClient(fetch, address, 'http://localhost:3000');
    const token = f.headers.cookie.split('=')[1]!;
    const workspaceId = f.owner.workspace.id.toUpperCase(),
      groupId = f.group.id.toUpperCase();
    expect(await client.list(token, workspaceId, groupId)).toMatchObject({
      status: 'available',
      value: { activeCount: 0 },
    });
    const command = { botId: f.bot.id.toUpperCase(), idempotencyKey: 'real-http' };
    const first = await client.invite(token, workspaceId, groupId, command);
    expect(first.status).toBe('available');
    if (first.status !== 'available') throw new Error('Expected live HTTP grant');
    expect(await client.invite(token, workspaceId, groupId, command)).toEqual(first);
    expect(
      await client.invite(token, workspaceId, groupId, { ...command, history: { mode: 'all' } }),
    ).toEqual({ status: 'idempotency-conflict' });
    const grant = first.value;
    await new ConversationService(new PostgresConversationRepository(f.pool)).append(
      f.owner.user.id,
      f.owner.workspace.id,
      grant.conversationId,
      { idempotencyKey: 'context', body: 'Actual persistent HTTP context' },
    );
    expect(await client.context(token, workspaceId, groupId, grant.id.toUpperCase())).toMatchObject(
      {
        status: 'available',
        value: {
          grantId: grant.id,
          messages: [{ body: 'Actual persistent HTTP context', canEdit: false }],
        },
      },
    );
    const removed = await client.remove(token, workspaceId, groupId, grant.id.toUpperCase(), {
      idempotencyKey: 'remove-real-http',
    });
    expect(removed).toMatchObject({
      status: 'available',
      value: { id: grant.id, closed: { reason: 'removed' } },
    });
    expect(
      await client.remove(token, workspaceId, groupId, grant.id, {
        idempotencyKey: 'remove-real-http',
      }),
    ).toEqual(removed);
    expect(await client.context(token, workspaceId, groupId, grant.id)).toEqual({
      status: 'forbidden',
    });
  });
  it('invites a Bot with one durable future-only grant and join event, replaying the same command', async () => {
    const f = await fixture();
    const command = { botId: f.bot.id, idempotencyKey: 'invite-helper' };
    const invite = () =>
      f.app.inject({ method: 'POST', url: f.base, headers: f.headers, payload: command });
    const first = await invite();
    expect(first.statusCode).toBe(200);
    const grant = first.json().grant;
    expect(grant).toMatchObject({
      id: expect.any(String),
      groupId: f.group.id,
      bot: { id: f.bot.id, name: 'Private helper' },
      conversationId: expect.any(String),
      grantedBy: { id: f.owner.user.id },
      history: { mode: 'future-only', lowerBound: 1 },
      joined: { eventId: expect.any(String), sequence: 1 },
      closed: null,
    });
    expect((await invite()).json()).toEqual(first.json());
    expect(
      (
        await f.pool.query(
          'SELECT event_type,message_id,message_version,sequence FROM conversation_events',
        )
      ).rows,
    ).toEqual([{ event_type: 'bot.joined', message_id: null, message_version: null, sequence: 1 }]);
    expect((await f.pool.query('SELECT id FROM group_bot_grants')).rows).toEqual([
      { id: grant.id },
    ]);
    expect(
      (await f.pool.query("SELECT metadata FROM audit_events WHERE event_type='group.bot_joined'"))
        .rows,
    ).toEqual([
      {
        metadata: {
          workspaceId: f.owner.workspace.id,
          groupId: f.group.id,
          conversationId: grant.conversationId,
          botId: f.bot.id,
          grantId: grant.id,
          eventId: grant.joined.eventId,
          sequence: 1,
          history: { mode: 'future-only', lowerBound: 1 },
        },
      },
    ]);
    const listed = await f.app.inject({ url: f.base, headers: f.headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      grants: [grant],
      canManage: true,
      activeCount: 1,
      maxActive: 8,
    });
    expect(first.body + listed.body).not.toMatch(
      /Instructions visible|never-return-provider-secret|connectionId|objectKey/,
    );
  });
  it('admits only original creations at the active grant boundary before projecting later edits', async () => {
    const f = await fixture();
    const messages = new ConversationService(new PostgresConversationRepository(f.pool));
    const conversation = await messages.open(f.owner.user.id, f.owner.workspace.id, {
      subject: { kind: 'group', id: f.group.id },
    });
    const old = await messages.append(f.owner.user.id, f.owner.workspace.id, conversation.id, {
      idempotencyKey: 'old',
      body: 'Pre-grant private content',
    });
    const invited = await f.app.inject({
      method: 'POST',
      url: f.base,
      headers: f.headers,
      payload: { botId: f.bot.id, idempotencyKey: 'join-after-original' },
    });
    const grant = invited.json().grant;
    const recent = await messages.append(f.owner.user.id, f.owner.workspace.id, conversation.id, {
      idempotencyKey: 'recent',
      body: 'Allowed recent content',
    });
    await messages.edit(f.owner.user.id, f.owner.workspace.id, conversation.id, old.messageId, {
      idempotencyKey: 'late-edit',
      expectedVersion: 1,
      body: 'Old message edited after joining',
    });
    const context = await f.app.inject({
      url: `${f.base}/${grant.id}/context`,
      headers: f.headers,
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      grantId: grant.id,
      conversationId: conversation.id,
      nextCursor: null,
      messages: [
        {
          id: recent.messageId,
          creationSequence: 3,
          body: 'Allowed recent content',
          canEdit: false,
          canDelete: false,
          canAudit: false,
        },
      ],
    });
    expect(context.json().messages).toHaveLength(1);
    expect(context.body).not.toMatch(
      /Pre-grant|Old message|Instructions visible|connectionId|never-return/,
    );
    await messages.tombstone(
      f.owner.user.id,
      f.owner.workspace.id,
      conversation.id,
      recent.messageId,
      { idempotencyKey: 'delete-recent', expectedVersion: 1 },
    );
    expect(
      (await f.app.inject({ url: `${f.base}/${grant.id}/context`, headers: f.headers })).json()
        .messages,
    ).toMatchObject([{ id: recent.messageId, deleted: true, body: null }]);
  });
  it.each(['all', 'since-event', 'since-time'] as const)(
    'persists the resolved %s bound and resumes current context using a reconstructed service',
    async (mode) => {
      const f = await fixture();
      const times = [
        '2026-09-05T00:00:00.000Z',
        '2026-09-05T00:00:01.000Z',
        '2026-09-05T00:00:02.000Z',
        '2026-09-05T00:00:03.000Z',
      ];
      const messages = new ConversationService(
        new PostgresConversationRepository(f.pool, () => new Date(times.shift()!)),
      );
      const conversation = await messages.open(f.owner.user.id, f.owner.workspace.id, {
        subject: { kind: 'group', id: f.group.id },
      });
      const receipts = [];
      for (const body of ['Oldest', 'Selected', 'Newest'])
        receipts.push(
          await messages.append(f.owner.user.id, f.owner.workspace.id, conversation.id, {
            body,
            idempotencyKey: body.replaceAll(' ', '-'),
          }),
        );
      const history =
        mode === 'since-event'
          ? { mode, eventId: receipts[1]!.eventId }
          : mode === 'since-time'
            ? { mode, time: '2026-09-05T00:00:02.000Z' }
            : { mode };
      const response = await f.app.inject({
        method: 'POST',
        url: f.base,
        headers: f.headers,
        payload: { botId: f.bot.id, idempotencyKey: 'explicit-history', history },
      });
      expect(response.statusCode).toBe(200);
      const grant = response.json().grant;
      expect(grant.history).toEqual({ ...history, lowerBound: mode === 'all' ? 1 : 2 });
      const first = await f.app.inject({
        url: `${f.base}/${grant.id}/context?limit=1`,
        headers: f.headers,
      });
      expect(first.json().messages.map((message: { body: string }) => message.body)).toEqual([
        mode === 'all' ? 'Oldest' : 'Selected',
      ]);
      const restarted = new GroupBotService(new PostgresGroupBotRepository(f.pool));
      const next = await restarted.context(
        f.owner.user.id,
        f.owner.workspace.id,
        f.group.id,
        grant.id,
        { cursor: first.json().nextCursor, limit: '100' },
      );
      expect(next.messages.map((message) => message.body)).toEqual(
        mode === 'all' ? ['Selected', 'Newest'] : ['Newest'],
      );
      expect(next.nextCursor).toBeNull();
      expect(
        (
          await f.pool.query('SELECT history_mode,lower_bound FROM group_bot_grants WHERE id=$1', [
            grant.id,
          ])
        ).rows,
      ).toEqual([{ history_mode: mode, lower_bound: mode === 'all' ? 1 : 2 }]);
    },
  );
  it('closes one pinned grant and requires a new explicit invitation to admit messages after the removal interval', async () => {
    const f = await fixture();
    const invite = (idempotencyKey: string, history?: { mode: 'all' }) =>
      f.app.inject({
        method: 'POST',
        url: f.base,
        headers: f.headers,
        payload: { botId: f.bot.id, idempotencyKey, ...(history ? { history } : {}) },
      });
    const first = (await invite('first-invite')).json().grant;
    const messages = new ConversationService(new PostgresConversationRepository(f.pool));
    const add = (body: string) =>
      messages.append(f.owner.user.id, f.owner.workspace.id, first.conversationId, {
        idempotencyKey: body.replaceAll(' ', '-'),
        body,
      });
    await add('First grant message');
    const remove = () =>
      f.app.inject({
        method: 'POST',
        url: `${f.base}/${first.id}/remove`,
        headers: f.headers,
        payload: { idempotencyKey: 'remove-first' },
      });
    const removed = await remove();
    expect(removed.statusCode).toBe(200);
    expect(removed.json().grant.closed).toMatchObject({
      eventId: expect.any(String),
      sequence: 3,
      reason: 'removed',
    });
    expect((await remove()).json()).toEqual(removed.json());
    await add('Absent interval');
    expect(
      (await f.app.inject({ url: `${f.base}/${first.id}/context`, headers: f.headers })).statusCode,
    ).toBe(403);
    const second = (await invite('second-invite')).json().grant;
    expect(second.id).not.toBe(first.id);
    expect(second.history).toEqual({ mode: 'future-only', lowerBound: 5 });
    await add('New grant message');
    const context = await f.app.inject({
      url: `${f.base}/${second.id}/context`,
      headers: f.headers,
    });
    expect(context.json().messages.map((message: { body: string }) => message.body)).toEqual([
      'New grant message',
    ]);
    expect((await invite('first-invite')).json().grant.id).toBe(first.id);
    expect((await invite('first-invite')).json().grant.closed).not.toBeNull();
    await f.app.inject({
      method: 'POST',
      url: `${f.base}/${second.id}/remove`,
      headers: f.headers,
      payload: { idempotencyKey: 'remove-second' },
    });
    const wider = (await invite('explicit-wider', { mode: 'all' })).json().grant;
    expect(
      (await f.app.inject({ url: `${f.base}/${wider.id}/context`, headers: f.headers }))
        .json()
        .messages.map((message: { body: string }) => message.body),
    ).toEqual(['First grant message', 'Absent interval', 'New grant message']);
    expect(
      (await f.pool.query('SELECT id FROM group_bot_grants WHERE close_event_id IS NULL')).rows,
    ).toEqual([{ id: wider.id }]);
  });
  it('rejects duplicate active membership and the ninth Bot without freeing disabled-model grants', async () => {
    const f = await fixture();
    const bots = [f.bot.id];
    for (let index = 1; index < 9; index++) {
      const bot = await new BotService(new PostgresBotRepository(f.pool)).create(
        f.owner.user.id,
        f.owner.workspace.id,
        {
          name: `Bot ${index}`,
          roleDescription: 'Researcher',
          instructions: 'Private instructions',
          modelBinding: {
            scope: { kind: 'personal', id: f.owner.user.id },
            connectionId: f.model.id,
            modelId: f.model.modelId,
          },
        },
      );
      bots.push(bot.id);
    }
    const invite = (botId: string, idempotencyKey: string) =>
      f.app.inject({
        method: 'POST',
        url: f.base,
        headers: f.headers,
        payload: { botId, idempotencyKey },
      });
    for (const [index, botId] of bots.slice(0, 8).entries())
      expect((await invite(botId, `invite-${index}`)).statusCode).toBe(200);
    const duplicate = await invite(f.bot.id, 'duplicate-new-command');
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: { code: 'group_bot_already_active' } });
    await f.providers.disable(f.owner.user.id, f.model.id);
    const ninth = await invite(bots[8]!, 'ninth');
    expect(ninth.statusCode).toBe(409);
    expect(ninth.json()).toEqual({ error: { code: 'group_bot_limit' } });
    expect((await f.app.inject({ url: f.base, headers: f.headers })).json().activeCount).toBe(8);
    expect(
      (await f.pool.query('SELECT sequence FROM conversation_events ORDER BY sequence')).rows.map(
        (row) => Number(row.sequence),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it.each(['bot', 'workspace'] as const)(
    'permanently closes grants in the same %s revocation flow without giving the revoker group-content rights',
    async (kind) => {
      const f = await fixture();
      const grantor = await f.addUser();
      const revoker = await f.addUser(kind === 'workspace' ? 'administrator' : 'member');
      await new GroupService(new PostgresGroupRepository(f.pool)).addMember(
        f.owner.user.id,
        f.owner.workspace.id,
        f.group.id,
        { userId: grantor.id, role: 'admin' },
      );
      const aclPath = `${f.path}/${f.bot.id}/acl`;
      for (const target of [grantor, ...(kind === 'bot' ? [revoker] : [])]) {
        expect(
          (
            await f.directApp.inject({
              method: 'POST',
              url: aclPath,
              headers: f.headers,
              payload: { userId: target.id, role: target.id === grantor.id ? 'user' : 'owner' },
            })
          ).statusCode,
        ).toBe(201);
      }
      const invited = await f.app.inject({
        method: 'POST',
        url: f.base,
        headers: grantor.headers,
        payload: { botId: f.bot.id, idempotencyKey: 'grantor-invite' },
      });
      expect(invited.statusCode).toBe(200);
      const grant = invited.json().grant;
      const path =
        kind === 'bot'
          ? `${aclPath}/${grantor.id}`
          : `/api/v1/workspaces/${f.owner.workspace.id}/members/${grantor.id}`;
      expect(
        (await f.directApp.inject({ method: 'DELETE', url: path, headers: revoker.headers }))
          .statusCode,
      ).toBe(204);
      const listed = await f.app.inject({ url: f.base, headers: f.headers });
      const closed = listed.json().grants[0];
      expect(closed.closed).toMatchObject({
        sequence: 2,
        reason: kind === 'bot' ? 'bot-access-revoked' : 'workspace-access-removed',
      });
      expect(closed.grantedBy.id).toBe(grantor.id);
      expect(
        (
          await f.pool.query(
            "SELECT actor_user_id,event_data FROM conversation_events WHERE event_type='bot.removed'",
            [],
          )
        ).rows,
      ).toMatchObject([
        { actor_user_id: revoker.id, event_data: { grantorUserId: grantor.id, grantId: grant.id } },
      ]);
      expect(
        (await f.app.inject({ url: `${f.base}/${grant.id}/context`, headers: f.headers }))
          .statusCode,
      ).toBe(403);
      expect((await f.app.inject({ url: f.base, headers: revoker.headers })).statusCode).toBe(403);
      if (kind === 'bot') {
        expect(
          (
            await f.directApp.inject({
              method: 'POST',
              url: aclPath,
              headers: f.headers,
              payload: { userId: grantor.id, role: 'user' },
            })
          ).statusCode,
        ).toBe(201);
      } else {
        await f.pool.query(
          "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'member',NOW())",
          [f.owner.workspace.id, grantor.id],
        );
      }
      expect(
        (await f.app.inject({ url: `${f.base}/${grant.id}/context`, headers: f.headers }))
          .statusCode,
      ).toBe(403);
      const replacement = (
        await f.app.inject({
          method: 'POST',
          url: f.base,
          headers: grantor.headers,
          payload: { botId: f.bot.id, idempotencyKey: 'explicit-reinvite' },
        })
      ).json().grant;
      expect(replacement.id).not.toBe(grant.id);
      expect(replacement.history.lowerBound).toBe(3);
      expect(
        (await f.app.inject({ url: `${f.base}/${replacement.id}/context`, headers: f.headers }))
          .statusCode,
      ).toBe(200);
    },
  );
});

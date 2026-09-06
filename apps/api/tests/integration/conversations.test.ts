import { newDb } from 'pg-mem';
import { registerAdvisoryXactLockStub } from '../helpers/provider-database.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConversationApiClient } from '../../../web/src/lib/server/conversation-api.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { PostgresAuthRepository, type SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { ConversationAccessError, ConversationService } from '../../src/conversations/service.js';
import {
  ConversationTransaction,
  PostgresConversationRepository,
} from '../../src/conversations/postgres-repository.js';

const token = Buffer.alloc(32, 21).toString('base64url');
const headers = { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };

describe('immutable conversation ledger', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  async function fixture(onQuery?: (statement: string) => void) {
    const database = newDb({ noAstCoverageCheck: true });
    registerAdvisoryXactLockStub(database);
    const pool = new (database.adapters.createPg().Pool)();
    cleanup.push(() => pool.end());
    await migrateDatabase(pool, { installPostgresGuards: false });
    const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
      hashPassword: async () => '$argon2id$conversation-test-only',
      generateSessionToken: () => token,
    });
    const owner = await auth.setup({
      displayName: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });
    const groups = new GroupService(new PostgresGroupRepository(pool));
    const group = await groups.create(owner.user.id, owner.workspace.id, { name: 'Incident room' });
    const ledgerPool: SqlPool = {
      connect: async () => {
        const connection = await pool.connect();
        return {
          query: async (statement, parameters) => {
            onQuery?.(statement);
            return connection.query(statement, parameters);
          },
          release: () => connection.release(),
        };
      },
    };
    const app = buildApp({
      auth,
      groups,
      conversations: new ConversationService(new PostgresConversationRepository(ledgerPool)),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    return {
      app,
      pool,
      owner,
      group,
      base: `/api/v1/workspaces/${owner.workspace.id}/conversations`,
    };
  }
  async function addUser(context: Awaited<ReturnType<typeof fixture>>, role = 'member') {
    const id = randomUUID(),
      session = randomBytes(32).toString('base64url'),
      now = new Date();
    await context.pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$2,$3)',
      [id, `${id}@example.com`, now],
    );
    await context.pool.query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4)',
      [context.owner.workspace.id, id, role, now],
    );
    await new PostgresAuthRepository(context.pool).createSession({
      userId: id,
      tokenDigest: createHash('sha256').update(session).digest('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3600000),
      auditId: randomUUID(),
    });
    return { id, headers: { ...headers, cookie: `openbot_session=${session}` } };
  }
  it('persists one group conversation and one append receipt when an authenticated command is replayed', async () => {
    const { app, pool, owner, group, base } = await fixture();
    const opened = await app.inject({
      method: 'POST',
      url: base,
      headers,
      payload: { subject: { kind: 'group', id: group.id } },
    });
    expect(opened.statusCode).toBe(200);
    const conversation = opened.json().conversation;
    const again = await app.inject({
      method: 'POST',
      url: base,
      headers,
      payload: { subject: { kind: 'group', id: group.id } },
    });
    expect(again.json().conversation.id).toBe(conversation.id);
    const command = { idempotencyKey: 'first-message', body: '  Preserve this message.\n' };
    const append = () =>
      app.inject({
        method: 'POST',
        url: `${base}/${conversation.id}/messages`,
        headers,
        payload: command,
      });
    const first = await append();
    expect(first.statusCode).toBe(200);
    expect((await append()).json()).toEqual(first.json());
    expect(first.json()).toEqual({
      receipt: { messageId: expect.any(String), eventId: expect.any(String), sequence: 1 },
    });
    expect(
      (await pool.query('SELECT sequence,body,actor_user_id FROM conversation_events')).rows,
    ).toEqual([{ sequence: 1, body: command.body, actor_user_id: owner.user.id }]);
    expect(
      (
        await pool.query(
          "SELECT metadata FROM audit_events WHERE event_type='conversation.message_created'",
        )
      ).rows,
    ).toEqual([
      {
        metadata: {
          workspaceId: owner.workspace.id,
          conversationId: conversation.id,
          ...first.json().receipt,
        },
      },
    ]);
  });
  it('reports replay inside the borrowed transaction so dependent writes can reuse their durable receipt', async () => {
    const { app, pool, owner, group, base } = await fixture();
    const opened = await app.inject({
      method: 'POST',
      url: base,
      headers,
      payload: { subject: { kind: 'group', id: group.id } },
    });
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      const ledger = await ConversationTransaction.lock(connection, {
        actorUserId: owner.user.id,
        workspaceId: owner.workspace.id,
        conversationId: opened.json().conversation.id,
      });
      const first = await ledger.append({
        idempotencyKey: 'with-dependent-write',
        body: 'One command',
      });
      expect(first).toMatchObject({ replayed: false, receipt: { sequence: 1 } });
      const replay = await ledger.append({
        idempotencyKey: 'with-dependent-write',
        body: 'One command',
      });
      expect(replay).toEqual({ ...first, replayed: true });
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
  });
  it('reads persisted current messages with safe author provenance after rebuilding the service', async () => {
    const { app, pool, owner, group, base } = await fixture();
    const opened = await app.inject({
      method: 'POST',
      url: base,
      headers,
      payload: { subject: { kind: 'group', id: group.id } },
    });
    const id = opened.json().conversation.id;
    const created = await app.inject({
      method: 'POST',
      url: `${base}/${id}/messages`,
      headers,
      payload: { idempotencyKey: 'read-me', body: 'First message' },
    });
    const read = await app.inject({ url: `${base}/${id}`, headers });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.json()).toMatchObject({
      conversation: { id, subject: { kind: 'group', id: group.id } },
      canWrite: true,
      nextCursor: null,
      messages: [
        {
          id: created.json().receipt.messageId,
          creationSequence: 1,
          versionEventId: created.json().receipt.eventId,
          sequence: 1,
          version: 1,
          author: { id: owner.user.id, displayName: 'Ada' },
          body: 'First message',
          deleted: false,
          canEdit: true,
          canDelete: true,
          canAudit: true,
        },
      ],
    });
    expect(JSON.stringify(read.json())).not.toMatch(/idempotency|command_hash|email|token/);
    const restarted = new ConversationService(new PostgresConversationRepository(pool));
    expect(await restarted.get(owner.user.id, owner.workspace.id, id, {})).toMatchObject({
      messages: [{ body: 'First message', sequence: 1 }],
    });
  });
  it('keeps direct Bot conversations private to their creator under current workspace and Bot permissions', async () => {
    const context = await fixture();
    const { app, pool, owner, base } = context;
    const peer = await addUser(context, 'owner');
    const botId = randomUUID(),
      versionId = randomUUID();
    await pool.query(
      "INSERT INTO bots(id,workspace_id,visibility,created_by_user_id,created_at,current_version_id) VALUES($1,$2,'private',$3,NOW(),$4)",
      [botId, owner.workspace.id, owner.user.id, versionId],
    );
    await pool.query(
      "INSERT INTO bot_versions(id,bot_id,version,configuration,author_user_id,created_at,rationale) VALUES($1,$2,1,$3::jsonb,$4,NOW(),'Created')",
      [
        versionId,
        botId,
        JSON.stringify({
          name: 'Unavailable Bot',
          roleDescription: 'Private helper',
          description: '',
          instructions: 'Private instructions',
          modelBinding: {
            scope: { kind: 'personal', id: owner.user.id },
            connectionId: randomUUID(),
            modelId: 'missing-model',
          },
          limits: {
            maxTotalTokens: 32768,
            maxDurationSeconds: 300,
            maxTurns: 8,
            maxDelegationDepth: 2,
          },
        }),
        owner.user.id,
      ],
    );
    for (const id of [owner.user.id, peer.id])
      await pool.query(
        "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'owner',NOW())",
        [botId, id],
      );
    const open = (actorHeaders: typeof headers) =>
      app.inject({
        method: 'POST',
        url: base,
        headers: actorHeaders,
        payload: { subject: { kind: 'direct-bot', id: botId } },
      });
    const first = await open(headers);
    expect(first.statusCode).toBe(200);
    const id = first.json().conversation.id;
    expect((await open(headers)).json().conversation.id).toBe(id);
    expect((await open(peer.headers)).json().conversation.id).not.toBe(id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/${id}/messages`,
          headers,
          payload: { idempotencyKey: 'private', body: 'Creator-only content' },
        })
      ).statusCode,
    ).toBe(200);
    const mine = await app.inject({ url: `${base}/${id}`, headers });
    expect(mine.json().messages[0].body).toBe('Creator-only content');
    expect(mine.body).not.toContain('Private instructions');
    expect((await app.inject({ url: `${base}/${id}`, headers: peer.headers })).statusCode).toBe(
      403,
    );
    await pool.query('DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [botId, owner.user.id]);
    expect((await app.inject({ url: `${base}/${id}`, headers })).statusCode).toBe(403);
    expect((await open(headers)).statusCode).toBe(403);
  });
  it('appends an immutable edit, replays before CAS and restricts prior bodies to the authorized version chain', async () => {
    const { app, pool, owner, group, base } = await fixture();
    const id = (
      await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { subject: { kind: 'group', id: group.id } },
      })
    ).json().conversation.id;
    const original = (
      await app.inject({
        method: 'POST',
        url: `${base}/${id}/messages`,
        headers,
        payload: { idempotencyKey: 'original', body: 'Original body' },
      })
    ).json().receipt;
    const path = `${base}/${id}/messages/${original.messageId}`;
    const command = { idempotencyKey: 'edit-1', expectedVersion: 1, body: '  Corrected body\n' };
    const changed = await app.inject({ method: 'PATCH', url: path, headers, payload: command });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().receipt).toMatchObject({ messageId: original.messageId, sequence: 2 });
    expect(
      (await app.inject({ method: 'PATCH', url: path, headers, payload: command })).json(),
    ).toEqual(changed.json());
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: path,
          headers,
          payload: { ...command, idempotencyKey: 'stale-edit' },
        })
      ).json(),
    ).toEqual({ error: { code: 'message_version_conflict' } });
    const current = await app.inject({ url: `${base}/${id}`, headers });
    expect(current.json().messages).toMatchObject([
      { id: original.messageId, creationSequence: 1, sequence: 2, version: 2, body: command.body },
    ]);
    expect(current.body).not.toContain('Original body');
    expect(
      (await pool.query('SELECT body FROM conversation_events WHERE id=$1', [original.eventId]))
        .rows,
    ).toEqual([{ body: 'Original body' }]);
    const chain = await app.inject({ url: `${path}/versions`, headers });
    expect(chain.statusCode).toBe(200);
    expect(chain.json().versions).toMatchObject([
      {
        id: original.eventId,
        type: 'message.created',
        version: 1,
        body: 'Original body',
        actor: { id: owner.user.id },
      },
      {
        id: changed.json().receipt.eventId,
        type: 'message.edited',
        version: 2,
        body: command.body,
      },
    ]);
    expect(chain.body).not.toMatch(/idempotency|command_hash/);
  });
  it('appends justified moderation tombstones, hides deleted bodies and denies non-author history and undelete', async () => {
    const context = await fixture();
    const { app, pool, group, base } = context;
    const author = await addUser(context),
      reader = await addUser(context);
    for (const user of [author, reader])
      await pool.query(
        "INSERT INTO group_memberships(group_id,user_id,role,created_at) VALUES($1,$2,'member',NOW())",
        [group.id, user.id],
      );
    const id = (
      await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { subject: { kind: 'group', id: group.id } },
      })
    ).json().conversation.id;
    const original = (
      await app.inject({
        method: 'POST',
        url: `${base}/${id}/messages`,
        headers: author.headers,
        payload: { idempotencyKey: 'message', body: 'Removed content' },
      })
    ).json().receipt;
    const path = `${base}/${id}/messages/${original.messageId}`;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: path,
          headers,
          payload: { idempotencyKey: 'rewrite', expectedVersion: 1, body: 'Moderator rewrite' },
        })
      ).statusCode,
    ).toBe(403);
    const deletion = { idempotencyKey: 'moderate', expectedVersion: 1, reason: '  Off topic  ' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${path}/tombstone`,
          headers,
          payload: { idempotencyKey: 'without-reason', expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(400);
    const removed = await app.inject({
      method: 'POST',
      url: `${path}/tombstone`,
      headers,
      payload: deletion,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().receipt).toMatchObject({ messageId: original.messageId, sequence: 2 });
    expect(
      (
        await app.inject({ method: 'POST', url: `${path}/tombstone`, headers, payload: deletion })
      ).json(),
    ).toEqual(removed.json());
    const projected = await app.inject({ url: `${base}/${id}`, headers: reader.headers });
    expect(projected.json().messages).toMatchObject([
      {
        deleted: true,
        body: null,
        reason: 'Off topic',
        canEdit: false,
        canDelete: false,
        canAudit: false,
        version: 2,
      },
    ]);
    expect(projected.body).not.toContain('Removed content');
    expect(
      (await app.inject({ url: `${path}/versions`, headers: reader.headers })).statusCode,
    ).toBe(403);
    for (const actorHeaders of [headers, author.headers])
      expect(
        (await app.inject({ url: `${path}/versions`, headers: actorHeaders })).json().versions,
      ).toMatchObject([
        { body: 'Removed content' },
        { type: 'message.deleted', body: null, reason: 'Off topic' },
      ]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: path,
          headers: author.headers,
          payload: { idempotencyKey: 'undelete', expectedVersion: 2, body: 'Undeleted' },
        })
      ).json(),
    ).toEqual({ error: { code: 'message_version_conflict' } });
    expect(
      (await pool.query('SELECT body FROM conversation_events WHERE id=$1', [original.eventId]))
        .rows,
    ).toEqual([{ body: 'Removed content' }]);
  });
  it('resumes creation-horizon pagination after restart while resolving current edits and tombstones', async () => {
    const { app, pool, owner, group, base } = await fixture();
    const id = (
      await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { subject: { kind: 'group', id: group.id } },
      })
    ).json().conversation.id;
    const receipts = [];
    for (const body of ['A', 'B', 'C'])
      receipts.push(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/messages`,
            headers,
            payload: { idempotencyKey: body, body },
          })
        ).json().receipt,
      );
    const first = await app.inject({ url: `${base}/${id}?limit=1`, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().messages.map((message: { body: string }) => message.body)).toEqual(['A']);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    await app.inject({
      method: 'POST',
      url: `${base}/${id}/messages`,
      headers,
      payload: { idempotencyKey: 'D', body: 'D after horizon' },
    });
    await app.inject({
      method: 'PATCH',
      url: `${base}/${id}/messages/${receipts[1].messageId}`,
      headers,
      payload: { idempotencyKey: 'B-edit', expectedVersion: 1, body: 'B current' },
    });
    await app.inject({
      method: 'POST',
      url: `${base}/${id}/messages/${receipts[2].messageId}/tombstone`,
      headers,
      payload: { idempotencyKey: 'C-delete', expectedVersion: 1 },
    });
    const restarted = new ConversationService(new PostgresConversationRepository(pool));
    const second = await restarted.get(owner.user.id, owner.workspace.id, id, {
      cursor: first.json().nextCursor,
      limit: '1',
    });
    expect(second.messages).toMatchObject([
      { body: 'B current', creationSequence: 2, sequence: 5 },
    ]);
    const third = await restarted.get(owner.user.id, owner.workspace.id, id, {
      cursor: second.nextCursor,
      limit: '1',
    });
    expect(third.messages).toMatchObject([
      { body: null, deleted: true, reason: 'Deleted by author', creationSequence: 3, sequence: 6 },
    ]);
    expect(third.nextCursor).toBeNull();
    expect((await restarted.get(owner.user.id, owner.workspace.id, id, {})).messages).toHaveLength(
      4,
    );
    for (const query of ['limit=0', 'limit=101', 'cursor=not-a-cursor'])
      expect((await app.inject({ url: `${base}/${id}?${query}`, headers })).statusCode).toBe(400);
  });
  it('pins canonical actor identity inside borrowed admission rather than trusting a later-mutated caller object', async () => {
    const context = await fixture();
    const { app, pool, owner, group, base } = context;
    const other = await addUser(context);
    const id = (
      await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { subject: { kind: 'group', id: group.id } },
      })
    ).json().conversation.id;
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      const access = {
        actorUserId: owner.user.id.toUpperCase(),
        workspaceId: owner.workspace.id.toUpperCase(),
        conversationId: id.toUpperCase(),
      };
      const admitted = await ConversationTransaction.lock(connection, access);
      access.actorUserId = other.id;
      const appended = await admitted.append({
        idempotencyKey: 'captured-actor',
        body: 'Original actor',
      });
      expect(
        (
          await connection.query('SELECT actor_user_id FROM conversation_events WHERE id=$1', [
            appended.receipt.eventId,
          ])
        ).rows,
      ).toEqual([{ actor_user_id: owner.user.id }]);
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
  });
  it.each(['metadata', 'read'] as const)(
    'keeps admitted reads, writes and audit scopes private when a caller mutates the %s view',
    async (view) => {
      const context = await fixture();
      const { pool, owner, group } = context;
      const other = await addUser(context);
      const otherWorkspaceId = randomUUID();
      await pool.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
        otherWorkspaceId,
        'Other workspace',
      ]);
      await pool.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'owner',NOW())",
        [otherWorkspaceId, other.id],
      );
      const otherGroup = await new GroupService(new PostgresGroupRepository(pool)).create(
        other.id,
        otherWorkspaceId,
        { name: 'Other private group' },
      );
      const service = new ConversationService(new PostgresConversationRepository(pool));
      const admittedConversation = await service.open(owner.user.id, owner.workspace.id, {
        subject: { kind: 'group', id: group.id },
      });
      const privateConversation = await service.open(other.id, otherWorkspaceId, {
        subject: { kind: 'group', id: otherGroup.id },
      });
      const privateMessage = await service.append(
        other.id,
        otherWorkspaceId,
        privateConversation.id,
        {
          idempotencyKey: 'private-message',
          body: 'Other workspace secret',
        },
      );
      await expect(
        service.get(owner.user.id, otherWorkspaceId, privateConversation.id, {}),
      ).rejects.toBeInstanceOf(ConversationAccessError);
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const ledger = await ConversationTransaction.lock(connection, {
          actorUserId: owner.user.id,
          workspaceId: owner.workspace.id,
          conversationId: admittedConversation.id,
        });
        const exposed =
          view === 'metadata' ? ledger.metadata : (await ledger.read({ limit: 30 })).conversation;
        Reflect.set(exposed, 'id', privateConversation.id);
        Reflect.set(exposed, 'workspaceId', otherWorkspaceId);
        Reflect.set(exposed.subject, 'id', otherGroup.id);
        exposed.createdAt.setTime(0);
        const created = await ledger.append({
          idempotencyKey: 'admitted-only',
          body: 'Allowed message',
        });
        expect(created.receipt.sequence).toBe(1);
        const page = await ledger.read({ limit: 30 });
        expect(page.conversation).toEqual(admittedConversation);
        expect(page.messages.map((message) => message.body)).toEqual(['Allowed message']);
        expect(await ledger.versions(created.receipt.messageId)).toMatchObject([
          { body: 'Allowed message' },
        ]);
        await expect(ledger.versions(privateMessage.messageId)).rejects.toBeInstanceOf(
          ConversationAccessError,
        );
        await connection.query('COMMIT');
        expect(
          (
            await pool.query(
              'SELECT conversation_id,actor_user_id FROM conversation_events WHERE id=$1',
              [created.receipt.eventId],
            )
          ).rows,
        ).toEqual([{ conversation_id: admittedConversation.id, actor_user_id: owner.user.id }]);
        expect(
          (
            await pool.query(
              "SELECT metadata FROM audit_events WHERE event_type='conversation.message_created' AND actor_user_id=$1",
              [owner.user.id],
            )
          ).rows,
        ).toEqual([
          {
            metadata: {
              workspaceId: owner.workspace.id,
              conversationId: admittedConversation.id,
              ...created.receipt,
            },
          },
        ]);
        expect(
          (
            await pool.query('SELECT last_sequence FROM conversations WHERE id=$1', [
              privateConversation.id,
            ])
          ).rows,
        ).toEqual([{ last_sequence: 1 }]);
      } finally {
        connection.release();
      }
    },
  );
  it('scopes command keys to the current principal and reauthorizes every replay without a workspace-admin bypass', async () => {
    const context = await fixture();
    const { app, pool, owner, group, base } = context;
    const reader = await addUser(context),
      administrator = await addUser(context, 'administrator');
    await pool.query("UPDATE groups SET visibility='workspace' WHERE id=$1", [group.id]);
    await pool.query(
      "INSERT INTO group_memberships(group_id,user_id,role,created_at) VALUES($1,$2,'member',NOW())",
      [group.id, reader.id],
    );
    const subject = { subject: { kind: 'group', id: group.id } };
    const id = (await app.inject({ method: 'POST', url: base, headers, payload: subject })).json()
      .conversation.id;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base,
          headers: administrator.headers,
          payload: subject,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `${base}/${id}`, headers: administrator.headers })).statusCode,
    ).toBe(403);
    const command = { idempotencyKey: 'same-key', body: 'Original private payload' };
    const first = await app.inject({
      method: 'POST',
      url: `${base}/${id}/messages`,
      headers,
      payload: command,
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `${base}/${id}/messages`,
      headers,
      payload: { ...command, body: 'Changed payload' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: { code: 'idempotency_conflict' } });
    const other = await app.inject({
      method: 'POST',
      url: `${base}/${id}/messages`,
      headers: reader.headers,
      payload: command,
    });
    expect(other.json().receipt.sequence).toBe(2);
    expect(other.json().receipt.messageId).not.toBe(first.json().receipt.messageId);
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
      owner.workspace.id,
      reader.id,
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/${id}/messages`,
          headers: reader.headers,
          payload: command,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: `${base}/${id}`, headers: reader.headers })).statusCode).toBe(
      403,
    );
    const otherWorkspace = randomUUID();
    expect(
      (
        await app.inject({
          url: `/api/v1/workspaces/${otherWorkspace}/conversations/${id}`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await pool.query('SELECT id FROM conversation_events WHERE conversation_id=$1', [id])).rows,
    ).toHaveLength(2);
  });
  it('validates bounded commands and server-owned fields while enforcing session and exact Origin', async () => {
    const { app, group, base } = await fixture();
    const subject = { subject: { kind: 'group', id: group.id } };
    const opened = await app.inject({ method: 'POST', url: base, headers, payload: subject });
    const path = `${base}/${opened.json().conversation.id}/messages`;
    for (const command of [
      {},
      [],
      { idempotencyKey: '', body: 'Text' },
      { idempotencyKey: 'a b', body: 'Text' },
      { idempotencyKey: 'k'.repeat(129), body: 'Text' },
      { idempotencyKey: 'key', body: ' ' },
      { idempotencyKey: 'key', body: 'x'.repeat(32001) },
      { idempotencyKey: 'key', body: 'Text', actorUserId: randomUUID() },
      { idempotencyKey: 'key', body: 'Text', sequence: 1 },
      { idempotencyKey: 'key', body: 'Text', eventType: 'task.created' },
    ]) {
      const result = await app.inject({ method: 'POST', url: path, headers, payload: command });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toEqual({ error: { code: 'invalid_conversation_request' } });
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base,
          headers,
          payload: { ...subject, creatorUserId: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
    const good = { idempotencyKey: 'bounded', body: 'x'.repeat(32000) };
    expect(
      (await app.inject({ method: 'POST', url: path, headers, payload: good })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { cookie: headers.cookie, origin: 'http://other.invalid' },
          payload: good,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { origin: headers.origin },
          payload: good,
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: base + '/invalid-id', headers })).statusCode).toBe(400);
  });
  it('crosses real HTTP with the strict Web client for open, replay, current pagination, edits, tombstones and audit chains', async () => {
    const { app, owner, group } = await fixture();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new ConversationApiClient(fetch, address, 'http://localhost:3000');
    const opened = await client.open(token, owner.workspace.id.toUpperCase(), {
      kind: 'group',
      id: group.id.toUpperCase(),
    });
    expect(opened.status).toBe('available');
    if (opened.status !== 'available') throw new Error('Expected conversation');
    const id = opened.value.id;
    const command = { idempotencyKey: 'real-http', body: '  Preserve formatting\n' };
    const first = await client.append(token, owner.workspace.id, id, command);
    expect(first.status).toBe('available');
    if (first.status !== 'available') throw new Error('Expected receipt');
    expect(await client.append(token, owner.workspace.id, id, command)).toEqual(first);
    expect(
      await client.append(token, owner.workspace.id, id, { ...command, body: 'Conflicting' }),
    ).toEqual({ status: 'idempotency-conflict' });
    await client.append(token, owner.workspace.id, id, {
      idempotencyKey: 'second-http',
      body: 'Second',
    });
    const page = await client.get(token, owner.workspace.id, id, { limit: 1 });
    expect(page.status).toBe('available');
    if (page.status !== 'available' || !page.value.nextCursor) throw new Error('Expected cursor');
    expect(page.value.messages[0]?.body).toBe(command.body);
    expect(
      await client.get(token, owner.workspace.id, id, { limit: 1, cursor: page.value.nextCursor }),
    ).toMatchObject({
      status: 'available',
      value: { messages: [{ body: 'Second' }], nextCursor: null },
    });
    expect(
      await client.edit(token, owner.workspace.id, id, first.value.messageId, {
        idempotencyKey: 'http-edit',
        expectedVersion: 1,
        body: 'Corrected',
      }),
    ).toMatchObject({ status: 'available', value: { sequence: 3 } });
    expect(
      await client.edit(token, owner.workspace.id, id, first.value.messageId, {
        idempotencyKey: 'http-stale',
        expectedVersion: 1,
        body: 'Stale',
      }),
    ).toEqual({ status: 'version-conflict' });
    expect(
      await client.tombstone(token, owner.workspace.id, id, first.value.messageId, {
        idempotencyKey: 'http-delete',
        expectedVersion: 2,
      }),
    ).toMatchObject({ status: 'available', value: { sequence: 4 } });
    expect(await client.get(token, owner.workspace.id, id)).toMatchObject({
      status: 'available',
      value: { messages: [{ body: null, deleted: true, version: 3 }, { body: 'Second' }] },
    });
    expect(
      await client.versions(token, owner.workspace.id, id, first.value.messageId),
    ).toMatchObject({
      status: 'available',
      value: [
        { body: command.body },
        { body: 'Corrected' },
        { body: null, reason: 'Deleted by author' },
      ],
    });
    expect(
      await client.get(Buffer.alloc(32, 33).toString('base64url'), owner.workspace.id, id),
    ).toEqual({ status: 'anonymous' });
    expect(
      await new ConversationApiClient(fetch, address, 'http://untrusted.invalid').append(
        token,
        owner.workspace.id,
        id,
        command,
      ),
    ).toEqual({ status: 'forbidden' });
  });
  it('masks unexpected database errors without treating them as missing identity or granting stale access', async () => {
    let failRead = false;
    const { app, group, base } = await fixture((statement) => {
      if (failRead && statement.includes('FROM conversations'))
        throw new Error('sensitive database diagnostic and private message body');
    });
    const id = (
      await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { subject: { kind: 'group', id: group.id } },
      })
    ).json().conversation.id;
    failRead = true;
    const result = await app.inject({ url: `${base}/${id}`, headers });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: { code: 'conversation_unavailable' } });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(200);
    failRead = false;
    expect((await app.inject({ url: `${base}/${id}`, headers })).statusCode).toBe(200);
  });
});

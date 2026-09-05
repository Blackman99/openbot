import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import {
  GroupBotService,
  GroupBotAccessError,
  GroupBotConflictError,
} from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupBotTransaction } from '../../src/group-bots/postgres-admission.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BotAclService } from '../../src/bots/acl-service.js';
import { PostgresBotAclRepository } from '../../src/bots/postgres-bot-acl-repository.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotService } from '../../src/bots/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

// Dedicated database job: this provisioner changes a fixed runtime role password.
const databaseUrl = process.env.TEST_GROUP_BOT_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'group Bot grants with deployed PostgreSQL permissions',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let runtime: pg.Pool;
    const acl = (pool: SqlPool = runtime) => new BotAclService(new PostgresBotAclRepository(pool));
    beforeAll(async () => {
      await migrateDatabase(admin);
      const url = new URL(databaseUrl!);
      const password = `ci-group-bot-${randomBytes(24).toString('hex')}`;
      await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../../../infra/postgres/grant-runtime-privileges.mjs', import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            PGHOST: url.hostname,
            PGPORT: url.port || '5432',
            PGDATABASE: url.pathname.slice(1),
            PGUSER: decodeURIComponent(url.username),
            PGPASSWORD: decodeURIComponent(url.password),
            OPENBOT_DATABASE_PASSWORD: password,
          },
        },
      );
      url.username = 'openbot_runtime';
      url.password = password;
      runtime = new pg.Pool({ connectionString: url.toString(), statement_timeout: 15000 });
    });
    afterAll(async () => {
      await runtime?.end();
      await admin.end();
    });
    async function fixture(botCount = 1) {
      const workspaceOwner = randomUUID(),
        first = randomUUID(),
        target = randomUUID(),
        workspaceId = randomUUID();
      for (const id of [workspaceOwner, first, target])
        await runtime.query(
          'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
          [id, `${id}@example.com`, 'Bot ACL member'],
        );
      await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
        workspaceId,
        'Bot ACL workspace',
      ]);
      for (const [id, role] of [
        [workspaceOwner, 'owner'],
        [first, 'member'],
        [target, 'member'],
      ])
        await runtime.query(
          'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
          [workspaceId, id, role],
        );
      const providers = new ProviderConnections(
        new PostgresProviderRepository(runtime),
        new ProviderSecretBox(randomBytes(32).toString('base64')),
        new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
        {
          // Capability evidence is a fixture. Authorization, transactions, role
          // grants, observed lock waits and rollback below use real PostgreSQL.
          run: async () => ({
            testedAt: new Date().toISOString(),
            text: { ok: true, code: 'passed', raw: 'OK' },
            action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
          }),
        },
      );
      const model = await providers.save(first, {
        name: 'Basic',
        baseUrl: 'https://models.example/v1',
        modelId: 'model',
        apiKey: 'native-fixture-secret',
        headers: {},
      });
      const bot = await new BotService(new PostgresBotRepository(runtime)).create(
        first,
        workspaceId,
        {
          name: 'Bot ACL',
          roleDescription: 'Assistant',
          instructions: 'Preserve evidence.',
          modelBinding: {
            scope: { kind: 'personal', id: first },
            connectionId: model.id,
            modelId: model.modelId,
          },
        },
      );
      const bots = [bot];
      for (let index = 1; index < botCount; index++)
        bots.push(
          await new BotService(new PostgresBotRepository(runtime)).create(first, workspaceId, {
            name: `Bot ${index}`,
            roleDescription: 'Assistant',
            instructions: 'Private',
            modelBinding: {
              scope: { kind: 'personal', id: first },
              connectionId: model.id,
              modelId: model.modelId,
            },
          }),
        );
      const group = await new GroupService(new PostgresGroupRepository(runtime)).create(
        target,
        workspaceId,
        { name: 'Grant history' },
      );
      await new GroupService(new PostgresGroupRepository(runtime)).addMember(
        target,
        workspaceId,
        group.id,
        { userId: first, role: 'admin' },
      );
      return { workspaceId, workspaceOwner, first, target, bot, bots, groupId: group.id };
    }
    function observedPool() {
      const name = `group-bot-${randomUUID()}`;
      return {
        name,
        pool: new pg.Pool({
          connectionString: runtime.options.connectionString,
          application_name: name,
          statement_timeout: 15000,
        }),
      };
    }
    async function waitForBlocked(name: string, blockerPid: number) {
      let pid = 0;
      await vi.waitFor(
        async () => {
          const result = await admin.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",
            [name, blockerPid],
          );
          expect(result.rows).toHaveLength(1);
          pid = result.rows[0]!.pid;
        },
        { timeout: 5000, interval: 20 },
      );
      return pid;
    }
    const service = (pool: SqlPool = runtime) =>
      new GroupBotService(new PostgresGroupBotRepository(pool));
    const messages = () => new ConversationService(new PostgresConversationRepository(runtime));
    async function counts(workspaceId: string) {
      return (
        await admin.query(
          `SELECT
      (SELECT COUNT(*)::int FROM group_bot_grants WHERE workspace_id=$1) AS grants,
      (SELECT COUNT(*)::int FROM conversations WHERE workspace_id=$1) AS conversations,
      (SELECT COALESCE(SUM(last_sequence),0)::int FROM conversations WHERE workspace_id=$1) AS sequence,
      (SELECT COUNT(*)::int FROM conversation_events e JOIN conversations c ON c.id=e.conversation_id WHERE c.workspace_id=$1) AS events,
      (SELECT COUNT(*)::int FROM audit_events WHERE event_type LIKE 'group.bot_%' AND metadata->>'workspaceId'=$1::text) AS audits`,
          [workspaceId],
        )
      ).rows[0];
    }
    async function invite(
      f: Awaited<ReturnType<typeof fixture>>,
      key = 'invite',
      botId = f.bot.id,
    ) {
      return service().invite(f.first, f.workspaceId, f.groupId, { botId, idempotencyKey: key });
    }
    it('enforces exact closure-column grants, retained rows, event provenance and irreversible closure', async () => {
      const f = await fixture(),
        grant = await invite(f);
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ])
        expect(
          (
            await admin.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [
              'openbot_runtime',
              'group_bot_grants',
              privilege,
            ])
          ).rows[0].allowed,
        ).toBe(['SELECT', 'INSERT'].includes(privilege));
      expect(
        (
          await admin.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='group_bot_grants' AND has_column_privilege('openbot_runtime',table_name,column_name,'UPDATE') ORDER BY column_name",
          )
        ).rows.map((row) => row.column_name),
      ).toEqual(['close_event_id', 'close_sequence', 'closed_at', 'closure_reason']);
      expect(
        (
          await admin.query(
            "SELECT has_function_privilege('openbot_runtime','protect_group_bot_grant()','EXECUTE') AS allowed",
          )
        ).rows[0].allowed,
      ).toBe(false);
      for (const sql of [
        'UPDATE group_bot_grants SET granted_by_user_id=$2 WHERE id=$1',
        'UPDATE group_bot_grants SET bot_id=$2 WHERE id=$1',
      ]) {
        await expect(runtime.query(sql, [grant.id, f.target])).rejects.toMatchObject({
          code: '42501',
        });
        await expect(admin.query(sql, [grant.id, f.target])).rejects.toMatchObject({
          code: '55000',
        });
      }
      await expect(
        runtime.query('DELETE FROM group_bot_grants WHERE id=$1', [grant.id]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        admin.query('DELETE FROM group_bot_grants WHERE id=$1', [grant.id]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(admin.query('TRUNCATE group_bot_grants CASCADE')).rejects.toMatchObject({
        code: '55000',
      });
      await expect(
        runtime.query(
          "UPDATE group_bot_grants SET close_event_id=join_event_id,close_sequence=join_sequence+1,closed_at=joined_at,closure_reason='removed' WHERE id=$1",
          [grant.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await service().remove(f.target, f.workspaceId, f.groupId, grant.id, {
        idempotencyKey: 'close',
      });
      for (const pool of [runtime, admin])
        await expect(
          pool.query(
            'UPDATE group_bot_grants SET close_event_id=NULL,close_sequence=NULL,closed_at=NULL,closure_reason=NULL WHERE id=$1',
            [grant.id],
          ),
        ).rejects.toMatchObject({ code: '55000' });
      const events = await admin.query(
        'SELECT sequence,event_type,membership_id,message_id FROM conversation_events WHERE conversation_id=$1 ORDER BY sequence',
        [grant.conversationId],
      );
      expect(events.rows).toEqual([
        { sequence: '1', event_type: 'bot.joined', membership_id: grant.id, message_id: null },
        { sequence: '2', event_type: 'bot.removed', membership_id: grant.id, message_id: null },
      ]);
    });
    it('serializes nine concurrent invitations into exactly eight active grants and one limit result', async () => {
      const f = await fixture(9);
      const results = await Promise.allSettled(
        f.bots.map((bot, index) => invite(f, `seat-${index}`, bot.id)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
      const failed = results.find((r) => r.status === 'rejected');
      expect(
        failed?.status === 'rejected' &&
          failed.reason instanceof GroupBotConflictError &&
          failed.reason.code,
      ).toBe('group_bot_limit');
      expect(await counts(f.workspaceId)).toEqual({
        grants: 8,
        conversations: 1,
        sequence: 8,
        events: 8,
        audits: 8,
      });
      expect((await service().list(f.target, f.workspaceId, f.groupId)).activeCount).toBe(8);
    });
    it('collapses concurrent duplicate command retries and rejects a second active grant', async () => {
      const f = await fixture();
      const results = await Promise.all([invite(f, 'same'), invite(f, 'same'), invite(f, 'same')]);
      expect(results.map((g) => g.id)).toEqual([results[0]!.id, results[0]!.id, results[0]!.id]);
      await expect(invite(f, 'new-command')).rejects.toMatchObject({
        code: 'group_bot_already_active',
      });
      expect(await counts(f.workspaceId)).toEqual({
        grants: 1,
        conversations: 1,
        sequence: 1,
        events: 1,
        audits: 1,
      });
    });
    it('rolls back a newly opened conversation, sequence, event and grant when mandatory audit insertion fails', async () => {
      const f = await fixture(),
        before = await counts(f.workspaceId);
      await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
      try {
        await expect(invite(f)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
      }
      expect(await counts(f.workspaceId)).toEqual(before);
      expect((await invite(f)).joined.sequence).toBe(1);
    });
    it.each(['bot', 'workspace'] as const)(
      'rolls back the entire %s revocation if the final revocation audit fails after closures',
      async (kind) => {
        const f = await fixture(),
          grant = await invite(f),
          before = await counts(f.workspaceId);
        const eventType = kind === 'bot' ? 'bot.acl_revoked' : 'workspace.member_removed';
        const suffix = randomBytes(8).toString('hex'),
          fn = `fail_col02_audit_${suffix}`;
        await admin.query(
          `CREATE FUNCTION ${fn}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='${eventType}' THEN RAISE EXCEPTION 'forced final audit failure'; END IF; RETURN NEW; END; $$`,
        );
        await admin.query(
          `CREATE TRIGGER ${fn} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        );
        if (kind === 'bot')
          await acl().grant(f.first, f.workspaceId, f.bot.id, {
            userId: f.workspaceOwner,
            role: 'owner',
          });
        try {
          const operation =
            kind === 'bot'
              ? acl().revoke(f.workspaceOwner, f.workspaceId, f.bot.id, f.first)
              : new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(runtime)).remove(
                  f.workspaceOwner,
                  f.workspaceId,
                  f.first,
                );
          await expect(operation).rejects.toThrow('forced final audit failure');
        } finally {
          await admin.query(`DROP TRIGGER ${fn} ON audit_events`);
          await admin.query(`DROP FUNCTION ${fn}()`);
        }
        expect(await counts(f.workspaceId)).toEqual(before);
        expect(
          (await service().list(f.target, f.workspaceId, f.groupId)).grants[0]!.closed,
        ).toBeNull();
        expect(
          (
            await runtime.query(
              'SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
              [f.workspaceId, f.first],
            )
          ).rows,
        ).toHaveLength(1);
        expect(
          (
            await runtime.query('SELECT user_id FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
              f.bot.id,
              f.first,
            ])
          ).rows,
        ).toHaveLength(1);
        expect(
          (await service().context(f.target, f.workspaceId, f.groupId, grant.id, {})).messages,
        ).toEqual([]);
      },
    );
    it.each(['bot', 'workspace'] as const)(
      'durably closes grants across groups for %s revocation, with actual actor provenance and no implicit content access',
      async (kind) => {
        const f = await fixture();
        const other = await new GroupService(new PostgresGroupRepository(runtime)).create(
          f.target,
          f.workspaceId,
          { name: 'Other history' },
        );
        await new GroupService(new PostgresGroupRepository(runtime)).addMember(
          f.target,
          f.workspaceId,
          other.id,
          { userId: f.first, role: 'admin' },
        );
        const first = await invite(f),
          second = await service().invite(f.first, f.workspaceId, other.id, {
            botId: f.bot.id,
            idempotencyKey: 'other',
          });
        if (kind === 'bot') {
          await acl().grant(f.first, f.workspaceId, f.bot.id, {
            userId: f.workspaceOwner,
            role: 'owner',
          });
          await acl().revoke(f.workspaceOwner, f.workspaceId, f.bot.id, f.first);
          await acl().grant(f.workspaceOwner, f.workspaceId, f.bot.id, {
            userId: f.first,
            role: 'user',
          });
        } else {
          await new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(runtime)).remove(
            f.workspaceOwner,
            f.workspaceId,
            f.first,
          );
          await runtime.query(
            "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'member',NOW())",
            [f.workspaceId, f.first],
          );
        }
        for (const [groupId, grant] of [
          [f.groupId, first],
          [other.id, second],
        ] as const) {
          await expect(
            service().context(f.target, f.workspaceId, groupId, grant.id, {}),
          ).rejects.toBeInstanceOf(GroupBotAccessError);
          await expect(
            service().list(f.workspaceOwner, f.workspaceId, groupId),
          ).rejects.toBeInstanceOf(GroupBotAccessError);
          expect((await service().list(f.target, f.workspaceId, groupId)).grants[0]).toMatchObject({
            grantedBy: { id: f.first },
            closed: {
              sequence: 2,
              reason: kind === 'bot' ? 'bot-access-revoked' : 'workspace-access-removed',
            },
          });
          const reopened = await service().invite(f.first, f.workspaceId, groupId, {
            botId: f.bot.id,
            idempotencyKey: 'reinvite',
          });
          expect(reopened.id).not.toBe(grant.id);
          expect(reopened.history.lowerBound).toBe(3);
        }
        expect(
          (
            await admin.query(
              "SELECT actor_user_id,event_data->>'grantorUserId' AS grantor FROM conversation_events WHERE event_type='bot.removed' AND conversation_id IN ($1,$2)",
              [first.conversationId, second.conversationId],
            )
          ).rows,
        ).toEqual([
          { actor_user_id: f.workspaceOwner, grantor: f.first },
          { actor_user_id: f.workspaceOwner, grantor: f.first },
        ]);
      },
    );
    it('pins borrowed context before a concurrent removal and keeps dependent writes in its caller transaction', async () => {
      const f = await fixture(),
        grant = await invite(f);
      await messages().append(f.target, f.workspaceId, grant.conversationId, {
        idempotencyKey: 'visible',
        body: 'Allowed context',
      });
      const connection = await runtime.connect(),
        observed = observedPool();
      let removing: Promise<unknown> | undefined;
      try {
        await connection.query('BEGIN');
        const pid = Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const input = {
          actorUserId: f.target,
          workspaceId: f.workspaceId,
          groupId: f.groupId,
          grantId: grant.id,
        };
        const admission = await GroupBotTransaction.lock(connection, input);
        input.grantId = randomUUID();
        input.groupId = randomUUID();
        removing = service(observed.pool).remove(f.target, f.workspaceId, f.groupId, grant.id, {
          idempotencyKey: 'wait-remove',
        });
        await waitForBlocked(observed.name, pid);
        const context = await admission.context({ limit: 30 });
        expect(context.grantId).toBe(grant.id);
        expect(context.messages.map((m) => m.body)).toEqual(['Allowed context']);
        await connection.query(
          "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'test.dependent_context',$2,NOW(),'{}')",
          [randomUUID(), f.target],
        );
        await expect(connection.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
        await connection.query('ROLLBACK');
        await removing;
        expect(
          (
            await admin.query(
              "SELECT id FROM audit_events WHERE event_type='test.dependent_context' AND actor_user_id=$1",
              [f.target],
            )
          ).rows,
        ).toHaveLength(0);
        await expect(
          service().context(f.target, f.workspaceId, f.groupId, grant.id, {}),
        ).rejects.toBeInstanceOf(GroupBotAccessError);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        await removing?.catch(() => {});
        await observed.pool.end();
      }
    });
    it('rechecks the waiting context reader after workspace removal commits', async () => {
      const f = await fixture(),
        grant = await invite(f),
        lock = await admin.connect(),
        observed = observedPool();
      let pending: Promise<unknown> | undefined;
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
        const pid = Number((await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        // The removal repository borrows this exact transaction for the fixture;
        // suppress only its nested BEGIN/COMMIT so admission and mutation run normally.
        const memberPool: SqlPool = {
          connect: async () => ({
            query: async (statement: string, parameters?: unknown[]) =>
              ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)
                ? { rows: [], rowCount: 0 }
                : lock.query(statement, parameters),
            release: () => undefined,
          }),
        };
        await new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(memberPool)).remove(
          f.workspaceOwner,
          f.workspaceId,
          f.target,
        );
        pending = service(observed.pool).context(f.target, f.workspaceId, f.groupId, grant.id, {});
        const rejected = expect(pending).rejects.toBeInstanceOf(GroupBotAccessError);
        await waitForBlocked(observed.name, pid);
        await lock.query('COMMIT');
        await rejected;
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
        await pending?.catch(() => {});
        await observed.pool.end();
      }
    });
    it('preserves original creation eligibility across edited history, tombstones and new grant boundaries on PostgreSQL', async () => {
      const f = await fixture();
      const conversation = await messages().open(f.target, f.workspaceId, {
        subject: { kind: 'group', id: f.groupId },
      });
      const old = await messages().append(f.target, f.workspaceId, conversation.id, {
        idempotencyKey: 'old',
        body: 'Before invitation',
      });
      const grant = await invite(f);
      const recent = await messages().append(f.target, f.workspaceId, conversation.id, {
        idempotencyKey: 'new',
        body: 'After invitation',
      });
      await messages().edit(f.target, f.workspaceId, conversation.id, old.messageId, {
        idempotencyKey: 'late-edit',
        expectedVersion: 1,
        body: 'Still excluded',
      });
      expect(
        (await service().context(f.target, f.workspaceId, f.groupId, grant.id, {})).messages.map(
          (m) => m.id,
        ),
      ).toEqual([recent.messageId]);
      await messages().tombstone(f.target, f.workspaceId, conversation.id, recent.messageId, {
        idempotencyKey: 'delete',
        expectedVersion: 1,
      });
      expect(
        (await service().context(f.target, f.workspaceId, f.groupId, grant.id, {})).messages,
      ).toMatchObject([{ id: recent.messageId, deleted: true, body: null }]);
      await service().remove(f.target, f.workspaceId, f.groupId, grant.id, {
        idempotencyKey: 'remove',
      });
      const wider = await service().invite(f.first, f.workspaceId, f.groupId, {
        botId: f.bot.id,
        idempotencyKey: 'wider',
        history: { mode: 'since-event', eventId: old.eventId },
      });
      const first = await service().context(f.target, f.workspaceId, f.groupId, wider.id, {
        limit: '1',
      });
      expect(first.messages.map((m) => m.body)).toEqual(['Still excluded']);
      const next = await service().context(f.target, f.workspaceId, f.groupId, wider.id, {
        cursor: first.nextCursor,
        limit: '1',
      });
      expect(next.messages).toMatchObject([{ id: recent.messageId, deleted: true }]);
      expect(next.nextCursor).toBeNull();
    });
    it('waits for affected group locks before acquiring any Bot lock during ACL revocation', async () => {
      const f = await fixture();
      await invite(f);
      await acl().grant(f.first, f.workspaceId, f.bot.id, {
        userId: f.workspaceOwner,
        role: 'owner',
      });
      const holdingGroup = await admin.connect(),
        probingBot = await admin.connect(),
        observed = observedPool();
      let pending: Promise<unknown> | undefined;
      try {
        await holdingGroup.query('BEGIN');
        await holdingGroup.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE', [f.groupId]);
        const pid = Number(
          (await holdingGroup.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        );
        pending = acl(observed.pool).revoke(f.workspaceOwner, f.workspaceId, f.bot.id, f.first);
        await waitForBlocked(observed.name, pid);
        await probingBot.query('BEGIN');
        await expect(
          probingBot.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE NOWAIT', [f.bot.id]),
        ).resolves.toMatchObject({ rowCount: 1 });
        await probingBot.query('ROLLBACK');
        await holdingGroup.query('COMMIT');
        await pending;
        expect((await service().list(f.target, f.workspaceId, f.groupId)).activeCount).toBe(0);
      } finally {
        await probingBot.query('ROLLBACK');
        await holdingGroup.query('ROLLBACK');
        probingBot.release();
        holdingGroup.release();
        await pending?.catch(() => {});
        await observed.pool.end();
      }
    });
    it.each(['invite', 'revoke'] as const)(
      'serializes invitation against ACL revocation when %s acquires authority first',
      async (first) => {
        const f = await fixture();
        await acl().grant(f.first, f.workspaceId, f.bot.id, {
          userId: f.workspaceOwner,
          role: 'owner',
        });
        const connection = await runtime.connect(),
          observed = observedPool();
        const borrowed: SqlPool = {
          connect: async () => ({
            query: async (statement, parameters) =>
              ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)
                ? { rows: [], rowCount: 0 }
                : connection.query(statement, parameters),
            release: () => undefined,
          }),
        };
        let pending: Promise<unknown> | undefined;
        try {
          await connection.query('BEGIN');
          const pid = Number(
            (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
          );
          if (first === 'invite') {
            const grant = await service(borrowed).invite(f.first, f.workspaceId, f.groupId, {
              botId: f.bot.id,
              idempotencyKey: 'race-invite',
            });
            pending = acl(observed.pool).revoke(f.workspaceOwner, f.workspaceId, f.bot.id, f.first);
            await waitForBlocked(observed.name, pid);
            await connection.query('COMMIT');
            await pending;
            expect(
              (await service().list(f.target, f.workspaceId, f.groupId)).grants[0],
            ).toMatchObject({ id: grant.id, closed: { reason: 'bot-access-revoked' } });
            expect(await counts(f.workspaceId)).toEqual({
              grants: 1,
              conversations: 1,
              sequence: 2,
              events: 2,
              audits: 2,
            });
          } else {
            await acl(borrowed).revoke(f.workspaceOwner, f.workspaceId, f.bot.id, f.first);
            pending = service(observed.pool).invite(f.first, f.workspaceId, f.groupId, {
              botId: f.bot.id,
              idempotencyKey: 'race-invite',
            });
            const rejected = expect(pending).rejects.toBeInstanceOf(GroupBotAccessError);
            await waitForBlocked(observed.name, pid);
            await connection.query('COMMIT');
            await rejected;
            expect(await counts(f.workspaceId)).toEqual({
              grants: 0,
              conversations: 0,
              sequence: 0,
              events: 0,
              audits: 0,
            });
          }
        } finally {
          await connection.query('ROLLBACK');
          connection.release();
          await pending?.catch(() => {});
          await observed.pool.end();
        }
      },
    );
  },
);

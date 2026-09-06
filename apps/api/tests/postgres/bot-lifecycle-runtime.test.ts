import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BotAclService } from '../../src/bots/acl-service.js';
import { BotAvatarService } from '../../src/bots/avatar-service.js';
import {
  BOT_DELETION_GRACE_MS,
  BotLifecycleConflictError,
  BotLifecycleService,
  BotRecoveryExpiredError,
} from '../../src/bots/lifecycle-service.js';
import { PostgresBotAclRepository } from '../../src/bots/postgres-bot-acl-repository.js';
import { lockAuthorizedBot } from '../../src/bots/postgres-bot-access.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotAccessError, BotModelError, BotService } from '../../src/bots/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { ConversationAccessError, ConversationService } from '../../src/conversations/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupBotAccessError, GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { authorizeProviderScope } from '../../src/providers/postgres-provider-scope.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { personalAccess } from '../../src/providers/scope.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

// Run sequentially after the other Bot native suites: the real deployed role
// provisioner rotates the fixed openbot_runtime password on this database.
const databaseUrl = process.env.TEST_BOT_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'Bot lifecycle with deployed PostgreSQL permissions',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let runtime: pg.Pool;
    const directories: string[] = [];
    const instant = new Date('2030-01-01T00:00:00.000Z');
    const deadline = new Date('2030-01-31T00:00:00.000Z');
    const operations = ['archive', 'restore', 'softDelete', 'undoDelete'] as const;
    type Operation = (typeof operations)[number];
    beforeAll(async () => {
      await migrateDatabase(admin);
      const url = new URL(databaseUrl!);
      const password = `ci-bot-lifecycle-${randomBytes(24).toString('hex')}`;
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
    afterEach(async () => {
      for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
    });
    afterAll(async () => {
      await runtime?.end();
      await admin.end();
    });

    function providers(pool = runtime) {
      return new ProviderConnections(
        new PostgresProviderRepository(pool),
        new ProviderSecretBox(randomBytes(32).toString('base64')),
        new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
        {
          // Basic capability evidence is a fixture. Deployed privileges, current
          // permission checks, transactions, locks, SQL guards and object I/O are real.
          run: async () => ({
            testedAt: new Date().toISOString(),
            text: { ok: true, code: 'passed', raw: 'OK' },
            action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
          }),
        },
      );
    }
    const lifecycle = (pool = runtime, now: () => Date = () => instant) =>
      new BotLifecycleService(pool, now);
    const acl = (pool = runtime) => new BotAclService(new PostgresBotAclRepository(pool));
    const bots = () => new BotService(new PostgresBotRepository(runtime));
    async function fixture() {
      const workspaceOwner = randomUUID(),
        actorId = randomUUID(),
        otherId = randomUUID(),
        workspaceId = randomUUID();
      for (const id of [workspaceOwner, actorId, otherId])
        await runtime.query(
          'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
          [id, `${id}@example.com`, 'Lifecycle member'],
        );
      await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
        workspaceId,
        'Lifecycle workspace',
      ]);
      for (const [id, role] of [
        [workspaceOwner, 'owner'],
        [actorId, 'member'],
        [otherId, 'administrator'],
      ])
        await runtime.query(
          'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
          [workspaceId, id, role],
        );
      const provider = providers();
      const model = await provider.save(actorId, {
        name: 'Lifecycle model',
        baseUrl: 'https://models.example/v1',
        modelId: 'lifecycle-model',
        apiKey: 'native-lifecycle-provider-secret',
        headers: {},
      });
      const bot = await bots().create(actorId, workspaceId, {
        name: 'Lifecycle assistant',
        roleDescription: 'Assistant',
        instructions: 'Keep historical evidence.',
        modelBinding: {
          scope: { kind: 'personal', id: actorId },
          connectionId: model.id,
          modelId: model.modelId,
        },
      });
      return {
        workspaceOwner,
        actorId,
        otherId,
        workspaceId,
        model,
        provider,
        bot,
        access: { actorUserId: actorId, workspaceId, botId: bot.id },
        args: [actorId, workspaceId, bot.id] as const,
      };
    }
    async function prepare(f: Awaited<ReturnType<typeof fixture>>, operation: Operation) {
      if (operation === 'restore') await lifecycle().archive(...f.args);
      if (operation === 'undoDelete') await lifecycle().softDelete(...f.args);
    }
    function observedPool() {
      const name = `bot-lifecycle-${randomUUID()}`;
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
    async function snapshot(botId: string) {
      return {
        bot: (await admin.query('SELECT * FROM bots WHERE id=$1', [botId])).rows,
        versions: (
          await admin.query('SELECT * FROM bot_versions WHERE bot_id=$1 ORDER BY id', [botId])
        ).rows,
        acl: (await admin.query('SELECT * FROM bot_acl WHERE bot_id=$1 ORDER BY user_id', [botId]))
          .rows,
        references: (
          await admin.query(
            'SELECT r.* FROM bot_avatar_references r JOIN bot_versions v ON v.id=r.version_id WHERE v.bot_id=$1 ORDER BY r.version_id',
            [botId],
          )
        ).rows,
        objects: (
          await admin.query('SELECT * FROM avatar_objects WHERE bot_id=$1 ORDER BY id', [botId])
        ).rows,
        audits: (
          await admin.query("SELECT * FROM audit_events WHERE metadata->>'botId'=$1 ORDER BY id", [
            botId,
          ])
        ).rows,
      };
    }
    function lifecycleEvents(state: Awaited<ReturnType<typeof snapshot>>) {
      return state.audits.filter((row) =>
        ['bot.archived', 'bot.restored', 'bot.soft_deleted', 'bot.deletion_undone'].includes(
          row.event_type,
        ),
      );
    }
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
      'base64',
    );
    async function avatar(f: Awaited<ReturnType<typeof fixture>>) {
      const directory = await mkdtemp(join(tmpdir(), 'openbot-lifecycle-native-'));
      directories.push(directory);
      const service = new BotAvatarService(runtime, new LocalObjectStore(directory));
      const version = await service.upload(f.access, f.bot.currentVersion!.id, png, 'image/png');
      return { service, version, bytes: await service.read(f.access, version.id) };
    }

    it('uses only exact lifecycle column updates and retains immutable identities, versions and no erasure grants', async () => {
      const f = await fixture();
      expect((await runtime.query('SELECT current_user AS role')).rows).toEqual([
        { role: 'openbot_runtime' },
      ]);
      const columns = await admin.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='bots' AND has_column_privilege('openbot_runtime','bots',column_name,'UPDATE') ORDER BY column_name",
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'current_version_id',
        'deleted_at',
        'lifecycle_state',
        'pre_deleted_state',
        'recovery_deadline',
        'visibility',
      ]);
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
              'bots',
              privilege,
            ])
          ).rows[0].allowed,
          privilege,
        ).toBe(['SELECT', 'INSERT'].includes(privilege));
      for (const statement of [
        'DELETE FROM bots WHERE id=$1',
        'UPDATE bots SET id=id WHERE id=$1',
        'UPDATE bots SET workspace_id=workspace_id WHERE id=$1',
        'UPDATE bots SET created_by_user_id=created_by_user_id WHERE id=$1',
        'UPDATE bots SET created_at=created_at WHERE id=$1',
      ])
        await expect(runtime.query(statement, [f.bot.id])).rejects.toMatchObject({ code: '42501' });
      for (const statement of [
        'UPDATE bot_versions SET configuration=configuration WHERE bot_id=$1',
        'DELETE FROM bot_versions WHERE bot_id=$1',
      ]) {
        await expect(runtime.query(statement, [f.bot.id])).rejects.toMatchObject({ code: '42501' });
        await expect(admin.query(statement, [f.bot.id])).rejects.toMatchObject({ code: '55000' });
      }
      const before = await snapshot(f.bot.id);
      for (const statement of [
        "UPDATE bots SET lifecycle_state='unknown' WHERE id=$1",
        "UPDATE bots SET lifecycle_state='deleted' WHERE id=$1",
        'UPDATE bots SET deleted_at=NOW() WHERE id=$1',
        "UPDATE bots SET pre_deleted_state='deleted' WHERE id=$1",
        "UPDATE bots SET lifecycle_state='deleted',deleted_at=NOW(),recovery_deadline=NOW(),pre_deleted_state='active' WHERE id=$1",
      ])
        await expect(runtime.query(statement, [f.bot.id])).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(f.bot.id)).toEqual(before);
    });

    it('requires a current explicit Bot owner for reads and every lifecycle transition without workspace or group bypass', async () => {
      const f = await fixture();
      await new GroupService(new PostgresGroupRepository(runtime)).create(
        f.otherId,
        f.workspaceId,
        { name: 'Group owner has no Bot bypass' },
      );
      await acl().changeVisibility(f.actorId, f.workspaceId, f.bot.id, { visibility: 'workspace' });
      for (const role of [null, 'editor', 'user'] as const) {
        if (role)
          await acl().grant(f.actorId, f.workspaceId, f.bot.id, { userId: f.otherId, role });
        const before = await snapshot(f.bot.id);
        for (const actor of [f.workspaceOwner, f.otherId])
          for (const operation of ['get', ...operations] as const)
            await expect(
              lifecycle()[operation](actor, f.workspaceId, f.bot.id),
            ).rejects.toBeInstanceOf(BotAccessError);
        expect(await snapshot(f.bot.id)).toEqual(before);
        if (role) await acl().revoke(f.actorId, f.workspaceId, f.bot.id, f.otherId);
      }
      await new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(runtime)).remove(
        f.workspaceOwner,
        f.workspaceId,
        f.actorId,
      );
      const before = await snapshot(f.bot.id);
      for (const operation of ['get', ...operations] as const)
        await expect(lifecycle()[operation](...f.args)).rejects.toBeInstanceOf(BotAccessError);
      expect(await snapshot(f.bot.id)).toEqual(before);
    });

    it.each(['archive', 'restore', 'softDelete'] as const)(
      'serializes duplicate %s requests into one effective audit without resampling time for the no-op',
      async (operation) => {
        const f = await fixture(),
          first = observedPool(),
          second = observedPool(),
          blocker = await admin.connect();
        await prepare(f, operation);
        const before = await snapshot(f.bot.id),
          now = vi.fn(() => instant);
        const pending: Promise<unknown>[] = [];
        try {
          await blocker.query('BEGIN');
          await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
          const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const a = lifecycle(first.pool, now)[operation](...f.args);
          pending.push(a);
          void a.catch(() => undefined);
          const firstPid = await waitForBlocked(first.name, pid);
          const b = lifecycle(second.pool, now)[operation](...f.args);
          pending.push(b);
          void b.catch(() => undefined);
          // The second row waiter queues behind the first, not the original holder.
          await waitForBlocked(second.name, firstPid);
          expect(now).not.toHaveBeenCalled();
          await blocker.query('COMMIT');
          expect(await b).toEqual(await a);
          expect(now).toHaveBeenCalledTimes(1);
          const after = await snapshot(f.bot.id);
          expect(lifecycleEvents(after)).toHaveLength(lifecycleEvents(before).length + 1);
          expect(after.versions).toEqual(before.versions);
          expect(after.acl).toEqual(before.acl);
          expect(after.bot[0].current_version_id).toBe(before.bot[0].current_version_id);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await Promise.allSettled(pending);
          await Promise.all([first.pool.end(), second.pool.end()]);
        }
      },
      20000,
    );

    it.each(['active', 'archived'] as const)(
      'retains the fixed 30-day delete window and recovers the previous %s state with exact safe provenance',
      async (previous) => {
        const f = await fixture(),
          retained = await avatar(f);
        let current = instant;
        const now = vi.fn(() => current),
          service = lifecycle(runtime, now);
        if (previous === 'archived') await service.archive(...f.args);
        const before = await snapshot(f.bot.id);
        const deleted = await service.softDelete(...f.args);
        expect(BOT_DELETION_GRACE_MS).toBe(2_592_000_000);
        expect(deleted).toEqual({
          botId: f.bot.id,
          workspaceId: f.workspaceId,
          state: 'deleted',
          deletedAt: instant,
          recoveryDeadline: deadline,
          preDeletedState: previous,
        });
        current = new Date('2030-01-20T12:00:00.000Z');
        now.mockClear();
        expect(await service.softDelete(...f.args)).toEqual(deleted);
        expect(await service.get(...f.args)).toEqual(deleted);
        await expect(service.archive(...f.args)).rejects.toBeInstanceOf(BotLifecycleConflictError);
        await expect(service.restore(...f.args)).rejects.toBeInstanceOf(BotLifecycleConflictError);
        expect(now).not.toHaveBeenCalled();
        expect(await bots().list(f.actorId, f.workspaceId)).toEqual([]);
        expect(await bots().list(f.actorId, f.workspaceId, 'usable')).toEqual([]);
        expect(await bots().list(f.actorId, f.workspaceId, 'deleted')).toMatchObject([
          { id: f.bot.id, lifecycleState: 'deleted' },
        ]);
        expect(await bots().list(f.workspaceOwner, f.workspaceId, 'deleted')).toEqual([]);
        const recovered = await service.undoDelete(...f.args);
        expect(recovered).toEqual({
          botId: f.bot.id,
          workspaceId: f.workspaceId,
          state: previous,
          deletedAt: null,
          recoveryDeadline: null,
          preDeletedState: null,
        });
        now.mockClear();
        expect(await service.undoDelete(...f.args)).toEqual(recovered);
        expect(await service.get(...f.args)).toEqual(recovered);
        expect(now).not.toHaveBeenCalled();
        const after = await snapshot(f.bot.id);
        expect(after.versions).toEqual(before.versions);
        expect(after.acl).toEqual(before.acl);
        expect(after.references).toEqual(before.references);
        expect(after.objects).toEqual(before.objects);
        expect(after.bot[0].current_version_id).toBe(retained.version.id);
        expect(await retained.service.read(f.access, retained.version.id)).toEqual(retained.bytes);
        const events = lifecycleEvents(after).filter((event) =>
          ['bot.soft_deleted', 'bot.deletion_undone'].includes(event.event_type),
        );
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event_type: 'bot.soft_deleted',
              actor_user_id: f.actorId,
              occurred_at: instant,
              metadata: {
                workspaceId: f.workspaceId,
                botId: f.bot.id,
                fromState: previous,
                toState: 'deleted',
                deletedAt: instant.toISOString(),
                recoveryDeadline: deadline.toISOString(),
              },
            }),
            expect.objectContaining({
              event_type: 'bot.deletion_undone',
              actor_user_id: f.actorId,
              occurred_at: current,
              metadata: {
                workspaceId: f.workspaceId,
                botId: f.bot.id,
                fromState: 'deleted',
                toState: previous,
              },
            }),
          ]),
        );
        expect(events).toHaveLength(2);
        expect(JSON.stringify(events)).not.toMatch(
          /native-lifecycle-provider-secret|apiKey|ciphertext|sealed_credentials/iu,
        );
      },
    );

    it('requires the actual restoring owner to use the stored model but permits undo-to-archived without provider admission', async () => {
      const f = await fixture(),
        service = lifecycle();
      await acl().grant(f.actorId, f.workspaceId, f.bot.id, { userId: f.otherId, role: 'owner' });
      await service.softDelete(...f.args);
      const deleted = await snapshot(f.bot.id);
      await expect(service.undoDelete(f.otherId, f.workspaceId, f.bot.id)).rejects.toMatchObject(
        new BotModelError('not-accessible'),
      );
      expect(await snapshot(f.bot.id)).toEqual(deleted);
      expect((await service.undoDelete(...f.args)).state).toBe('active');
      await service.archive(...f.args);
      await service.softDelete(...f.args);
      await f.provider.disable(f.actorId, f.model.id);
      expect((await service.undoDelete(f.otherId, f.workspaceId, f.bot.id)).state).toBe('archived');
      const archived = await snapshot(f.bot.id);
      await expect(service.restore(f.otherId, f.workspaceId, f.bot.id)).rejects.toMatchObject(
        new BotModelError('not-accessible'),
      );
      await expect(service.restore(...f.args)).rejects.toMatchObject(new BotModelError('disabled'));
      expect(await snapshot(f.bot.id)).toEqual(archived);
    });

    it.each(['restore', 'undoDelete'] as const)(
      'revalidates the current stored model after a queued %s waits on its personal provider scope',
      async (operation) => {
        for (const reason of [
          'disabled',
          'binding-changed',
          'capability-unavailable',
          'not-accessible',
        ] as const) {
          const f = await fixture(),
            observer = observedPool(),
            blocker = await runtime.connect();
          await prepare(f, operation);
          const before = await snapshot(f.bot.id),
            now = vi.fn(() => instant);
          let pending: Promise<unknown> | undefined;
          try {
            await blocker.query('BEGIN');
            await authorizeProviderScope(blocker, personalAccess(f.actorId), 'manage');
            const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            pending = lifecycle(observer.pool, now)[operation](...f.args);
            const rejected = expect(pending).rejects.toMatchObject(new BotModelError(reason));
            void rejected.catch(() => undefined);
            await waitForBlocked(observer.name, pid);
            expect(now).not.toHaveBeenCalled();
            if (reason === 'disabled')
              await blocker.query(
                "UPDATE personal_model_connections SET metadata=jsonb_set(metadata,'{enabled}','false'::jsonb) WHERE id=$1",
                [f.model.id],
              );
            else if (reason === 'binding-changed')
              await blocker.query(
                "UPDATE personal_model_connections SET metadata=jsonb_set(metadata,'{modelId}',to_jsonb('changed-model'::text)) WHERE id=$1",
                [f.model.id],
              );
            else if (reason === 'capability-unavailable')
              await blocker.query(
                "UPDATE personal_model_connections SET policy='{}'::jsonb WHERE id=$1",
                [f.model.id],
              );
            else
              await blocker.query('DELETE FROM personal_model_connections WHERE id=$1', [
                f.model.id,
              ]);
            await blocker.query('COMMIT');
            await rejected;
            expect(now).not.toHaveBeenCalled();
            expect(await snapshot(f.bot.id)).toEqual(before);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            await pending?.catch(() => undefined);
            await observer.pool.end();
          }
        }
      },
      30000,
    );

    it('keeps admitted provider authority through the restore commit before a queued disable proceeds', async () => {
      const f = await fixture(),
        restorer = observedPool(),
        disabler = observedPool(),
        blocker = await admin.connect();
      await lifecycle().archive(...f.args);
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const restore = lifecycle(restorer.pool).restore(...f.args);
        pending.push(restore);
        void restore.catch(() => undefined);
        const restorerPid = await waitForBlocked(restorer.name, pid);
        const disabled = providers(disabler.pool).disable(f.actorId, f.model.id);
        pending.push(disabled);
        void disabled.catch(() => undefined);
        await waitForBlocked(disabler.name, restorerPid);
        expect(
          (await admin.query('SELECT lifecycle_state FROM bots WHERE id=$1', [f.bot.id])).rows,
        ).toEqual([{ lifecycle_state: 'archived' }]);
        await blocker.query('COMMIT');
        expect((await restore).state).toBe('active');
        expect((await disabled).enabled).toBe(false);
        expect(
          lifecycleEvents(await snapshot(f.bot.id)).filter(
            (row) => row.event_type === 'bot.restored',
          ),
        ).toHaveLength(1);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all([restorer.pool.end(), disabler.pool.end()]);
      }
    }, 20000);

    it('rejects undo at the exact deadline reached during provider admission and retains the expired identity', async () => {
      const f = await fixture(),
        observer = observedPool(),
        blocker = await runtime.connect();
      const deleted = await lifecycle().softDelete(...f.args),
        before = await snapshot(f.bot.id);
      let current = new Date(deadline.getTime() - 1);
      const now = vi.fn(() => current);
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await authorizeProviderScope(blocker, personalAccess(f.actorId), 'manage');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = lifecycle(observer.pool, now).undoDelete(...f.args);
        const rejected = expect(pending).rejects.toBeInstanceOf(BotRecoveryExpiredError);
        void rejected.catch(() => undefined);
        await waitForBlocked(observer.name, pid);
        expect(now).not.toHaveBeenCalled();
        current = deadline;
        await blocker.query('COMMIT');
        await rejected;
        expect(now).toHaveBeenCalledTimes(1);
        expect(await snapshot(f.bot.id)).toEqual(before);
        expect(
          await lifecycle(runtime, () => new Date('2031-01-01T00:00:00Z')).softDelete(...f.args),
        ).toEqual(deleted);
        expect(await snapshot(f.bot.id)).toEqual(before);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => undefined);
        await observer.pool.end();
      }
    }, 20000);

    it('starts the full deletion grace only after queued workspace admission finishes', async () => {
      const f = await fixture(),
        observer = observedPool(),
        blocker = await admin.connect();
      let current = instant;
      const now = vi.fn(() => current);
      let pending: ReturnType<BotLifecycleService['softDelete']> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = lifecycle(observer.pool, now).softDelete(...f.args);
        void pending.catch(() => undefined);
        await waitForBlocked(observer.name, pid);
        expect(now).not.toHaveBeenCalled();
        current = new Date('2030-02-01T12:00:00.000Z');
        await blocker.query('COMMIT');
        expect(await pending).toMatchObject({
          deletedAt: current,
          recoveryDeadline: new Date('2030-03-03T12:00:00.000Z'),
        });
        expect(now).toHaveBeenCalledTimes(1);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => undefined);
        await observer.pool.end();
      }
    }, 20000);

    it.each(operations)(
      'denies queued %s after a Bot-owner grant or workspace membership is revoked first',
      async (operation) => {
        for (const kind of ['bot-acl', 'workspace'] as const) {
          const f = await fixture(),
            revoker = observedPool(),
            observer = observedPool(),
            blocker = await admin.connect();
          await prepare(f, operation);
          await acl().grant(f.actorId, f.workspaceId, f.bot.id, {
            userId: f.workspaceOwner,
            role: 'owner',
          });
          const before = await snapshot(f.bot.id),
            now = vi.fn(() => instant);
          const pending: Promise<unknown>[] = [];
          try {
            await blocker.query('BEGIN');
            await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
            const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const revoked =
              kind === 'bot-acl'
                ? acl(revoker.pool).revoke(f.workspaceOwner, f.workspaceId, f.bot.id, f.actorId)
                : new WorkspaceMemberService(
                    new PostgresWorkspaceMemberRepository(revoker.pool),
                  ).remove(f.workspaceOwner, f.workspaceId, f.actorId);
            pending.push(revoked);
            void revoked.catch(() => undefined);
            const revokerPid = await waitForBlocked(revoker.name, pid);
            const operationPending = lifecycle(observer.pool, now)[operation](...f.args);
            const rejected = expect(operationPending).rejects.toBeInstanceOf(BotAccessError);
            pending.push(operationPending, rejected);
            void rejected.catch(() => undefined);
            await waitForBlocked(observer.name, revokerPid);
            await blocker.query('COMMIT');
            await revoked;
            await rejected;
            const after = await snapshot(f.bot.id);
            expect(after.bot).toEqual(before.bot);
            expect(after.versions).toEqual(before.versions);
            expect(lifecycleEvents(after)).toEqual(lifecycleEvents(before));
            expect(now).not.toHaveBeenCalled();
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            await Promise.allSettled(pending);
            await Promise.all([revoker.pool.end(), observer.pool.end()]);
          }
        }
      },
      20000,
    );

    it.each(['bot-acl', 'workspace'] as const)(
      'commits an admitted archive before queued %s revocation removes its authority',
      async (kind) => {
        const f = await fixture(),
          writer = observedPool(),
          revoker = observedPool(),
          blocker = await admin.connect();
        await acl().grant(f.actorId, f.workspaceId, f.bot.id, {
          userId: f.workspaceOwner,
          role: 'owner',
        });
        const pending: Promise<unknown>[] = [];
        try {
          await blocker.query('BEGIN');
          await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
          const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const archived = lifecycle(writer.pool).archive(...f.args);
          pending.push(archived);
          void archived.catch(() => undefined);
          const writerPid = await waitForBlocked(writer.name, pid);
          const revoked =
            kind === 'bot-acl'
              ? acl(revoker.pool).revoke(f.workspaceOwner, f.workspaceId, f.bot.id, f.actorId)
              : new WorkspaceMemberService(
                  new PostgresWorkspaceMemberRepository(revoker.pool),
                ).remove(f.workspaceOwner, f.workspaceId, f.actorId);
          pending.push(revoked);
          void revoked.catch(() => undefined);
          await waitForBlocked(revoker.name, writerPid);
          expect(
            (await admin.query('SELECT lifecycle_state FROM bots WHERE id=$1', [f.bot.id])).rows,
          ).toEqual([{ lifecycle_state: 'active' }]);
          await blocker.query('COMMIT');
          expect((await archived).state).toBe('archived');
          await revoked;
          expect(lifecycleEvents(await snapshot(f.bot.id))).toEqual([
            expect.objectContaining({
              event_type: 'bot.archived',
              metadata: {
                workspaceId: f.workspaceId,
                botId: f.bot.id,
                fromState: 'active',
                toState: 'archived',
              },
            }),
          ]);
          await expect(lifecycle().get(...f.args)).rejects.toBeInstanceOf(BotAccessError);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await Promise.allSettled(pending);
          await Promise.all([writer.pool.end(), revoker.pool.end()]);
        }
      },
      20000,
    );

    it.each(operations)(
      'rolls back %s lifecycle fields and audit together while preserving history and avatar objects',
      async (operation) => {
        const f = await fixture(),
          retained = await avatar(f);
        await prepare(f, operation);
        const before = await snapshot(f.bot.id);
        await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
        try {
          await expect(lifecycle()[operation](...f.args)).rejects.toMatchObject({ code: '42501' });
        } finally {
          await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
        }
        expect(await snapshot(f.bot.id)).toEqual(before);
        expect(await retained.service.read(f.access, retained.version.id)).toEqual(retained.bytes);
        expect(await retained.service.cleanup()).toEqual({ retained: 0, deleted: 0, retried: 0 });
      },
    );

    it('retains direct and group history with stable state markers while archived and deleted Bots deny new use', async () => {
      const f = await fixture();
      const groups = new GroupService(new PostgresGroupRepository(runtime));
      const group = await groups.create(f.actorId, f.workspaceId, { name: 'Retained Bot history' });
      await groups.addMember(f.actorId, f.workspaceId, group.id, {
        userId: f.otherId,
        role: 'member',
      });
      await acl().grant(f.actorId, f.workspaceId, f.bot.id, { userId: f.otherId, role: 'user' });
      const grants = new GroupBotService(new PostgresGroupBotRepository(runtime));
      const grant = await grants.invite(f.actorId, f.workspaceId, group.id, {
        botId: f.bot.id,
        idempotencyKey: 'original-invitation',
      });
      const conversations = new ConversationService(new PostgresConversationRepository(runtime));
      const subject = { kind: 'direct-bot', id: f.bot.id };
      const conversation = await conversations.open(f.actorId, f.workspaceId, { subject });
      await conversations.append(f.actorId, f.workspaceId, conversation.id, {
        body: 'Retained original message',
        idempotencyKey: 'original-message',
      });
      const versions = (await snapshot(f.bot.id)).versions;
      const grantRows = (
        await admin.query('SELECT * FROM group_bot_grants WHERE id=$1', [grant.id])
      ).rows;
      for (const operation of ['archive', 'softDelete'] as const) {
        const state = operation === 'archive' ? 'archived' : 'deleted';
        await lifecycle()[operation](...f.args);
        const connection = await runtime.connect();
        try {
          await connection.query('BEGIN');
          await expect(lockAuthorizedBot(connection, f.access, 'use')).rejects.toBeInstanceOf(
            BotAccessError,
          );
        } finally {
          await connection.query('ROLLBACK');
          connection.release();
        }
        await expect(
          conversations.open(f.otherId, f.workspaceId, { subject }),
        ).rejects.toBeInstanceOf(ConversationAccessError);
        await expect(
          conversations.append(f.actorId, f.workspaceId, conversation.id, {
            body: 'Denied new work',
            idempotencyKey: `denied-${state}`,
          }),
        ).rejects.toBeInstanceOf(ConversationAccessError);
        expect(
          (await conversations.get(f.actorId, f.workspaceId, conversation.id, {})).messages,
        ).toMatchObject([{ body: 'Retained original message' }]);
        expect((await conversations.open(f.actorId, f.workspaceId, { subject })).id).toBe(
          conversation.id,
        );
        await expect(
          grants.context(f.otherId, f.workspaceId, group.id, grant.id, {}),
        ).rejects.toBeInstanceOf(GroupBotAccessError);
        await expect(
          grants.invite(f.actorId, f.workspaceId, group.id, {
            botId: f.bot.id,
            idempotencyKey: `denied-${state}`,
          }),
        ).rejects.toBeInstanceOf(GroupBotAccessError);
        const list = await grants.list(f.otherId, f.workspaceId, group.id);
        expect(list.activeCount).toBe(1);
        expect(list.grants).toMatchObject([
          { id: grant.id, closed: null, bot: { id: f.bot.id, lifecycleState: state } },
        ]);
        expect(
          (await admin.query('SELECT * FROM group_bot_grants WHERE id=$1', [grant.id])).rows,
        ).toEqual(grantRows);
        expect((await snapshot(f.bot.id)).versions).toEqual(versions);
        expect((await bots().get(f.actorId, f.workspaceId, f.bot.id)).lifecycleState).toBe(state);
      }
    });
  },
);

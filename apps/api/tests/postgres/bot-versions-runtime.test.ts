import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotVersionService } from '../../src/bots/version-service.js';
import { BotAvatarService } from '../../src/bots/avatar-service.js';
import { BotVersionConflictError } from '../../src/bots/append-version.js';
import { BotModelError } from '../../src/bots/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotAccessError, BotService } from '../../src/bots/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { authorizeProviderScope } from '../../src/providers/postgres-provider-scope.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { personalAccess } from '../../src/providers/scope.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

// The real provisioner changes the fixed runtime role password. This URL must
// target its own disposable PostgreSQL service, not the auth/provider/OIDC job.
const databaseUrl = process.env.TEST_BOT_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'Bot version edits/restoration with the deployed restricted role',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let runtime: pg.Pool;
    const directories: string[] = [];
    afterEach(async () => {
      for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
    });
    beforeAll(async () => {
      await migrateDatabase(admin);
      const url = new URL(databaseUrl!);
      const password = `ci-bot-runtime-${randomBytes(24).toString('hex')}`;
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

    function providers(pool: pg.Pool) {
      return new ProviderConnections(
        new PostgresProviderRepository(pool),
        new ProviderSecretBox(randomBytes(32).toString('base64')),
        new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
        {
          // Only establishes a Basic model fixture; native SQL, locks and grants
          // below are real. This is not evidence about upstream model transport.
          run: async () => ({
            testedAt: new Date().toISOString(),
            text: { ok: true, code: 'passed', raw: 'OK' },
            action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
          }),
        },
      );
    }
    async function fixture() {
      const ownerId = randomUUID();
      const actorId = randomUUID();
      const workspaceId = randomUUID();
      for (const id of [ownerId, actorId])
        await runtime.query(
          'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
          [id, `${id}@example.com`, 'Bot author'],
        );
      await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
        workspaceId,
        'Bots',
      ]);
      for (const [id, role] of [
        [ownerId, 'owner'],
        [actorId, 'member'],
      ])
        await runtime.query(
          'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
          [workspaceId, id, role],
        );
      const model = await providers(runtime).save(actorId, {
        name: 'Basic model',
        baseUrl: 'https://models.example/v1',
        modelId: 'model',
        apiKey: 'ci-bot-provider-secret',
        headers: {},
      });
      return {
        ownerId,
        actorId,
        workspaceId,
        model,
        input: {
          name: 'Research assistant',
          roleDescription: 'Researcher',
          description: 'Finds evidence',
          instructions: 'Preserve source quotations.',
          modelBinding: {
            scope: { kind: 'personal', id: actorId },
            connectionId: model.id,
            modelId: model.modelId,
          },
        },
      };
    }
    function observedPool() {
      const name = `bot-${randomUUID()}`;
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
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
      'base64',
    );
    async function versionFixture() {
      const f = await fixture();
      const bot = await new BotService(new PostgresBotRepository(runtime)).create(
        f.actorId,
        f.workspaceId,
        f.input,
      );
      const directory = await mkdtemp(join(tmpdir(), 'openbot-version-native-'));
      directories.push(directory);
      const store = new LocalObjectStore(directory),
        avatars = new BotAvatarService(runtime, store);
      return {
        ...f,
        bot,
        access: { actorUserId: f.actorId, workspaceId: f.workspaceId, botId: bot.id },
        versionId: bot.currentVersion!.id,
        store,
        avatars,
        service: new BotVersionService(runtime, avatars),
      };
    }
    async function waitForIO(ready: Promise<void>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('fixture image reader did not arrive')),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    async function counts(botId: string) {
      return (
        await admin.query(
          `SELECT
      (SELECT COUNT(*)::int FROM bot_versions WHERE bot_id=$1) AS versions,
      (SELECT COUNT(*)::int FROM bot_avatar_references r JOIN bot_versions v ON v.id=r.version_id WHERE v.bot_id=$1) AS references,
      (SELECT COUNT(*)::int FROM audit_events WHERE event_type='bot.version_created' AND metadata->>'botId'=$1::text) AS audits`,
          [botId],
        )
      ).rows[0];
    }
    it('serializes simultaneous edit and restore preconditions so exactly one new immutable version commits', async () => {
      const f = await versionFixture(),
        a = observedPool(),
        b = observedPool(),
        blocker = await admin.connect();
      const actions: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        actions.push(
          new BotVersionService(a.pool, f.avatars).edit(f.access, {
            expectedCurrentVersionId: f.versionId,
            changes: { name: 'Concurrent edit' },
          }),
        );
        actions.push(
          new BotVersionService(b.pool, f.avatars).restore(f.access, {
            expectedCurrentVersionId: f.versionId,
            sourceVersionId: f.versionId,
          }),
        );
        const settled = Promise.allSettled(actions);
        await waitForBlocked(a.name, pid);
        await waitForBlocked(b.name, pid);
        await blocker.query('COMMIT');
        const results = await settled;
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
          reason: expect.any(BotVersionConflictError),
        });
        expect(await counts(f.bot.id)).toEqual({ versions: 2, references: 0, audits: 1 });
        expect((await f.service.get(f.access, f.versionId)).configuration).toEqual(
          f.bot.currentVersion!.configuration,
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(actions);
        await Promise.all([a.pool.end(), b.pool.end()]);
      }
    }, 20000);
    it.each(['edit', 'restore'] as const)(
      'rechecks a queued %s actor after current workspace or Bot permission revocation',
      async (action) => {
        for (const revoked of ['workspace', 'bot-acl']) {
          const f = await versionFixture(),
            observer = observedPool(),
            blocker = await admin.connect();
          let pending: Promise<unknown> | undefined;
          try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
              f.workspaceId,
            ]);
            const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const service = new BotVersionService(observer.pool, f.avatars);
            pending =
              action === 'edit'
                ? service.edit(f.access, {
                    expectedCurrentVersionId: f.versionId,
                    changes: { name: 'Denied' },
                  })
                : service.restore(f.access, {
                    expectedCurrentVersionId: f.versionId,
                    sourceVersionId: f.versionId,
                  });
            const denied = expect(pending).rejects.toBeInstanceOf(BotAccessError);
            void denied.catch(() => {});
            await waitForBlocked(observer.name, pid);
            if (revoked === 'workspace')
              await blocker.query(
                'DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
                [f.workspaceId, f.actorId],
              );
            else
              await blocker.query('DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
                f.bot.id,
                f.actorId,
              ]);
            await blocker.query('COMMIT');
            await denied;
            expect(await counts(f.bot.id)).toEqual({ versions: 1, references: 0, audits: 0 });
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            await pending?.catch(() => {});
            await observer.pool.end();
          }
        }
      },
      20000,
    );
    it('rolls back configuration, restored avatar reference, pointer and audit together on mandatory audit failure', async () => {
      const f = await versionFixture();
      const uploaded = await f.avatars.upload(f.access, f.versionId, png, 'image/png');
      const removed = await f.avatars.remove(f.access, uploaded.id);
      const before = await counts(f.bot.id);
      await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
      try {
        await expect(
          f.service.edit(f.access, {
            expectedCurrentVersionId: removed.id,
            changes: { name: 'Must roll back' },
          }),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          f.service.restore(f.access, {
            expectedCurrentVersionId: removed.id,
            sourceVersionId: uploaded.id,
          }),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
      }
      expect(await counts(f.bot.id)).toEqual(before);
      expect(
        (await admin.query('SELECT current_version_id FROM bots WHERE id=$1', [f.bot.id])).rows,
      ).toEqual([{ current_version_id: removed.id }]);
      expect((await f.service.get(f.access, uploaded.id)).configuration.avatarObjectId).toBe(
        uploaded.configuration.avatarObjectId,
      );
      expect(await f.avatars.cleanup()).toMatchObject({ retained: 1, deleted: 0 });
    });
    it.each(['disabled', 'binding-changed', 'capability-unavailable'] as const)(
      'revalidates %s model state after waiting for the same-transaction provider lock',
      async (reason) => {
        const f = await versionFixture(),
          observer = observedPool(),
          blocker = await runtime.connect();
        let pending: Promise<unknown> | undefined;
        const now = vi.fn(() => new Date());
        try {
          await blocker.query('BEGIN');
          await authorizeProviderScope(blocker, personalAccess(f.actorId), 'manage');
          const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          pending = new BotVersionService(observer.pool, f.avatars, now).restore(f.access, {
            expectedCurrentVersionId: f.versionId,
            sourceVersionId: f.versionId,
          });
          const rejected = expect(pending).rejects.toMatchObject(new BotModelError(reason));
          void rejected.catch(() => {});
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
          else
            await blocker.query(
              "UPDATE personal_model_connections SET policy='{}'::jsonb WHERE id=$1",
              [f.model.id],
            );
          await blocker.query('COMMIT');
          await rejected;
          expect(await counts(f.bot.id)).toEqual({ versions: 1, references: 0, audits: 0 });
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await pending?.catch(() => {});
          await observer.pool.end();
        }
      },
      20000,
    );
    it('retains every historical avatar reference through config edits and restore while cleanup runs', async () => {
      const f = await versionFixture();
      const uploaded = await f.avatars.upload(f.access, f.versionId, png, 'image/png');
      const edited = await f.service.edit(f.access, {
        expectedCurrentVersionId: uploaded.id,
        changes: { instructions: 'Updated instructions' },
      });
      const removed = await f.avatars.remove(f.access, edited.id);
      const restored = await f.service.restore(f.access, {
        expectedCurrentVersionId: removed.id,
        sourceVersionId: uploaded.id,
      });
      expect(restored.number).toBe(5);
      expect(restored.configuration).toEqual(uploaded.configuration);
      expect(await f.avatars.cleanup()).toMatchObject({ retained: 1, deleted: 0 });
      expect(await counts(f.bot.id)).toEqual({ versions: 5, references: 3, audits: 4 });
      for (const version of [uploaded, edited, restored])
        expect((await f.avatars.read(f.access, version.id)).subarray(0, 8)).toEqual(
          png.subarray(0, 8),
        );
      const events = (
        await admin.query(
          "SELECT metadata FROM audit_events WHERE event_type='bot.version_created' AND metadata->>'versionId'=$1::text",
          [restored.id],
        )
      ).rows;
      expect(events[0].metadata).toMatchObject({
        restoredFromVersionId: uploaded.id,
        changedFields: ['instructions', 'avatarObjectId'],
      });
    });

    it.each(['revoked-edit', 'stale-version'] as const)(
      'rechecks %s after historical avatar I/O before the final restore publication',
      async (failure) => {
        const f = await versionFixture(),
          observer = observedPool(),
          blocker = await admin.connect();
        const uploaded = await f.avatars.upload(f.access, f.versionId, png, 'image/png');
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const proceed = new Promise<void>((resolve) => {
          release = resolve;
        });
        const reader = {
          read: async (...args: Parameters<BotAvatarService['read']>) => {
            const bytes = await f.avatars.read(...args);
            entered();
            await proceed;
            return bytes;
          },
        };
        const pending = new BotVersionService(observer.pool, reader).restore(f.access, {
          expectedCurrentVersionId: uploaded.id,
          sourceVersionId: uploaded.id,
        });
        const rejected = expect(pending).rejects.toBeInstanceOf(
          failure === 'revoked-edit' ? BotAccessError : BotVersionConflictError,
        );
        void rejected.catch(() => {});
        try {
          await waitForIO(ready);
          if (failure === 'stale-version') {
            // This must finish while the image reader is paused: remote object I/O owns no SQL locks.
            await f.service.edit(f.access, {
              expectedCurrentVersionId: uploaded.id,
              changes: { description: 'Concurrent change retained' },
            });
          }
          await blocker.query('BEGIN');
          await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
          const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          if (failure === 'revoked-edit')
            await blocker.query("UPDATE bot_acl SET role='user' WHERE bot_id=$1 AND user_id=$2", [
              f.bot.id,
              f.actorId,
            ]);
          release();
          await waitForBlocked(observer.name, pid);
          await blocker.query('COMMIT');
          await rejected;
          expect(await counts(f.bot.id)).toEqual({
            versions: failure === 'stale-version' ? 3 : 2,
            references: failure === 'stale-version' ? 2 : 1,
            audits: failure === 'stale-version' ? 2 : 1,
          });
        } finally {
          release();
          await blocker.query('ROLLBACK');
          blocker.release();
          await pending.catch(() => {});
          await observer.pool.end();
        }
      },
      20000,
    );
    it('samples version and audit timestamps after the final successful provider admission', async () => {
      const f = await versionFixture(),
        observer = observedPool(),
        blocker = await runtime.connect();
      let pending: ReturnType<BotVersionService['edit']> | undefined;
      let instant = new Date('2030-01-01T00:00:00.000Z');
      const clock = vi.fn(() => instant);
      try {
        await blocker.query('BEGIN');
        await authorizeProviderScope(blocker, personalAccess(f.actorId), 'manage');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = new BotVersionService(observer.pool, f.avatars, clock).edit(f.access, {
          expectedCurrentVersionId: f.versionId,
          changes: {
            name: 'After admission',
            modelBinding: f.bot.currentVersion!.configuration.modelBinding,
          },
        });
        void pending.catch(() => {});
        await waitForBlocked(observer.name, pid);
        expect(clock).not.toHaveBeenCalled();
        instant = new Date('2030-01-01T00:05:00.000Z');
        await blocker.query('COMMIT');
        const version = await pending;
        expect(version.createdAt).toEqual(instant);
        expect(clock).toHaveBeenCalledTimes(1);
        expect(
          (
            await admin.query(
              "SELECT occurred_at FROM audit_events WHERE event_type='bot.version_created' AND metadata->>'versionId'=$1::text",
              [version.id],
            )
          ).rows,
        ).toEqual([{ occurred_at: instant }]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => {});
        await observer.pool.end();
      }
    }, 20000);
  },
);

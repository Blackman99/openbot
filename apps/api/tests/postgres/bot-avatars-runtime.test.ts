import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appendBotVersion,
  BotAvatarUnavailableError,
  BotVersionConflictError,
} from '../../src/bots/append-version.js';
import { avatarAccess, BotAvatarService } from '../../src/bots/avatar-service.js';
import { BotAccessError } from '../../src/bots/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import {
  createObjectKey,
  ObjectNotFoundError,
  type ObjectKey,
  type ObjectStore,
} from '../../src/objects/store.js';

// Run serially after bots-runtime: the real provisioner rotates the fixed role password.
// No database URL means an explicit unverified native-service gate, not a simulated pass.
const databaseUrl = process.env.TEST_BOT_DATABASE_URL;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
const instant = new Date('2030-01-01T00:00:00.000Z');
function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
(databaseUrl ? describe : describe.skip)(
  'Bot avatars with the deployed restricted PostgreSQL role',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let runtime: pg.Pool;
    const directories: string[] = [];
    beforeAll(async () => {
      await migrateDatabase(admin);
      const url = new URL(databaseUrl!);
      const password = `ci-avatar-runtime-${randomBytes(24).toString('hex')}`;
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
    async function fixture() {
      const actorUserId = randomUUID(),
        workspaceId = randomUUID(),
        botId = randomUUID(),
        versionId = randomUUID();
      const directory = await mkdtemp(join(tmpdir(), 'openbot-avatar-native-'));
      directories.push(directory);
      const store = new LocalObjectStore(directory);
      const configuration = {
        name: 'Avatar Bot',
        roleDescription: 'Helper',
        description: '',
        instructions: 'Help.',
        // An unchanged unavailable binding must not be readmitted by an avatar-only edit.
        modelBinding: {
          scope: { kind: 'personal', id: actorUserId },
          connectionId: randomUUID(),
          modelId: 'unavailable-model',
        },
        limits: {
          maxTotalTokens: 32768,
          maxDurationSeconds: 300,
          maxTurns: 8,
          maxDelegationDepth: 2,
        },
      };
      const connection = await runtime.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,$4)',
          [actorUserId, `${actorUserId}@example.com`, 'Avatar author', instant],
        );
        await connection.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,$3)', [
          workspaceId,
          'Avatar workspace',
          instant,
        ]);
        await connection.query(
          "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)",
          [workspaceId, actorUserId, instant],
        );
        await connection.query(
          'INSERT INTO bots(id,workspace_id,current_version_id,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5)',
          [botId, workspaceId, versionId, actorUserId, instant],
        );
        await connection.query(
          "INSERT INTO bot_versions(id,bot_id,version,configuration,author_user_id,created_at,rationale) VALUES($1,$2,1,$3::jsonb,$4,$5,'Created')",
          [versionId, botId, JSON.stringify(configuration), actorUserId, instant],
        );
        await connection.query(
          "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)",
          [botId, actorUserId, instant],
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
      return {
        access: avatarAccess(actorUserId, workspaceId, botId),
        versionId,
        configuration,
        store,
        service: new BotAvatarService(runtime, store, undefined, () => instant),
      };
    }
    function observedPool() {
      const name = `avatar-${randomUUID()}`;
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
    function pausedStore(store: ObjectStore, operation: 'save' | 'read' | 'delete', arrivals = 1) {
      const entered = gate(),
        proceed = gate();
      let calls = 0;
      async function pause() {
        if (++calls === arrivals) entered.release();
        await proceed.ready;
      }
      const wrapped: ObjectStore = {
        identity: store.identity,
        async save(key, bytes, signal) {
          await store.save(key, bytes, signal);
          if (operation === 'save') await pause();
        },
        async read(key, maxBytes, signal) {
          const bytes = await store.read(key, maxBytes, signal);
          if (operation === 'read') await pause();
          return bytes;
        },
        async delete(key, signal) {
          if (operation === 'delete') await pause();
          await store.delete(key, signal);
        },
      };
      return { store: wrapped, entered: entered.ready, release: proceed.release };
    }
    async function orphan(f: Awaited<ReturnType<typeof fixture>>) {
      const key = createObjectKey(f.access.workspaceId);
      await runtime.query(
        "INSERT INTO avatar_objects(id,workspace_id,bot_id,backend_id,state,bytes,sha256,width,height,created_at,lease_until,cleanup_after) VALUES($1,$2,$3,$4,'live',$5,$6,1,1,$7,$7,$7)",
        [
          key.objectId,
          key.workspaceId,
          f.access.botId,
          f.store.identity,
          png.length,
          createHash('sha256').update(png).digest('hex'),
          instant,
        ],
      );
      await f.store.save(key, png);
      return key;
    }
    async function restore(pool: pg.Pool, f: Awaited<ReturnType<typeof fixture>>, key: ObjectKey) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const version = await appendBotVersion(
          connection,
          f.access,
          { expectedCurrentVersionId: f.versionId, changes: { avatarObjectId: key.objectId } },
          () => instant,
        );
        await connection.query('COMMIT');
        return version;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }

    it('allows exactly one concurrent avatar CAS and cleans only its unpublished losing intent', async () => {
      const f = await fixture();
      const paused = pausedStore(f.store, 'save', 2);
      const service = new BotAvatarService(runtime, paused.store, undefined, () => instant);
      const pending = [
        service.upload(f.access, f.versionId, png, 'image/png'),
        service.upload(f.access, f.versionId, png, 'image/png'),
      ];
      const results = Promise.allSettled(pending);
      try {
        await vi.waitFor(
          async () => {
            await expect(
              admin.query("SELECT id FROM avatar_objects WHERE bot_id=$1 AND state='staged'", [
                f.access.botId,
              ]),
            ).resolves.toMatchObject({ rowCount: 2 });
          },
          { timeout: 5000, interval: 20 },
        );
        await boundedReady(paused.entered);
      } finally {
        paused.release();
        await results;
      }
      const settled = await results;
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const winner = settled.find((result) => result.status === 'fulfilled');
      const loser = settled.find((result) => result.status === 'rejected');
      expect(loser?.reason).toBeInstanceOf(BotVersionConflictError);
      expect(winner?.value).toMatchObject({ number: 2, configuration: f.configuration });
      expect(await counts(f.access.botId)).toEqual({ versions: 2, references: 1, audits: 1 });
      expect(
        (await admin.query('SELECT configuration FROM bot_versions WHERE id=$1', [f.versionId]))
          .rows[0].configuration,
      ).toEqual(f.configuration);
      expect(await f.service.cleanup()).toEqual({ retained: 0, deleted: 1, retried: 0 });
      expect((await f.service.read(f.access)).subarray(0, 8)).toEqual(png.subarray(0, 8));
    });

    it.each(['upload', 'read'] as const)(
      'reauthorizes queued %s after Bot ACL or workspace membership revocation',
      async (operation) => {
        for (const scope of ['bot-acl', 'workspace-membership'] as const) {
          const f = await fixture();
          if (operation === 'read') await f.service.upload(f.access, f.versionId, png, 'image/png');
          const before = await counts(f.access.botId);
          const paused = pausedStore(f.store, operation === 'upload' ? 'save' : 'read');
          const observer = observedPool();
          const service = new BotAvatarService(
            observer.pool,
            paused.store,
            undefined,
            () => instant,
          );
          const blocker = await admin.connect();
          const pending =
            operation === 'upload'
              ? service.upload(f.access, f.versionId, png, 'image/png')
              : service.read(f.access);
          const denied = expect(pending).rejects.toBeInstanceOf(BotAccessError);
          void denied.catch(() => undefined);
          try {
            await boundedReady(paused.entered);
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
              f.access.workspaceId,
            ]);
            const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            // Only the fixture uses owner authority to revoke ACLs; the request uses runtime grants.
            if (scope === 'bot-acl')
              await blocker.query('DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
                f.access.botId,
                f.access.actorUserId,
              ]);
            else
              await blocker.query(
                'DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
                [f.access.workspaceId, f.access.actorUserId],
              );
            paused.release();
            await waitForBlocked(observer.name, pid);
            await blocker.query('COMMIT');
            await denied;
            expect(await counts(f.access.botId)).toEqual(before);
            if (operation === 'upload')
              expect(await f.service.cleanup()).toEqual({ retained: 0, deleted: 1, retried: 0 });
          } finally {
            paused.release();
            await blocker.query('ROLLBACK');
            blocker.release();
            await Promise.allSettled([pending, denied]);
            await observer.pool.end();
          }
        }
      },
      20000,
    );

    it('rolls back publication, pointer, references and cleanup scheduling when mandatory audit insertion fails', async () => {
      const f = await fixture();
      const first = await f.service.upload(f.access, f.versionId, png, 'image/png');
      const oldBytes = await f.service.read(f.access);
      await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
      try {
        await expect(f.service.upload(f.access, first.id, png, 'image/png')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(f.service.remove(f.access, first.id)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
      }
      expect(await counts(f.access.botId)).toEqual({ versions: 2, references: 1, audits: 1 });
      expect(
        (await admin.query('SELECT current_version_id FROM bots WHERE id=$1', [f.access.botId]))
          .rows,
      ).toEqual([{ current_version_id: first.id }]);
      expect(
        (
          await admin.query('SELECT state,cleanup_after FROM avatar_objects WHERE id=$1', [
            first.configuration.avatarObjectId,
          ])
        ).rows,
      ).toEqual([{ state: 'live', cleanup_after: null }]);
      expect(await f.service.cleanup()).toEqual({ retained: 0, deleted: 1, retried: 0 });
      expect(await f.service.read(f.access)).toEqual(oldBytes);
    });

    it('retains immutable historical references when replacement and removal queue earlier objects', async () => {
      const f = await fixture();
      const first = await f.service.upload(f.access, f.versionId, png, 'image/png');
      const second = await f.service.upload(f.access, first.id, png, 'image/png');
      const removed = await f.service.remove(f.access, second.id);
      expect(removed).toMatchObject({ number: 4, configuration: { avatarObjectId: null } });
      expect(await f.service.cleanup()).toEqual({ retained: 2, deleted: 0, retried: 0 });
      await expect(f.service.read(f.access)).rejects.toBeInstanceOf(ObjectNotFoundError);
      for (const version of [first, second])
        expect((await f.service.read(f.access, version.id)).subarray(0, 8)).toEqual(
          png.subarray(0, 8),
        );
      expect(await counts(f.access.botId)).toEqual({ versions: 4, references: 2, audits: 3 });
    });

    it('makes cleanup wait for a reference publisher holding the workspace and object lock order', async () => {
      const f = await fixture();
      const key = await orphan(f);
      const publisher = observedPool(),
        cleaner = observedPool();
      const blocker = await admin.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM avatar_objects WHERE id=$1 FOR UPDATE', [key.objectId]);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const publication = restore(publisher.pool, f, key);
        pending.push(publication);
        void publication.catch(() => undefined);
        const publisherPid = await waitForBlocked(publisher.name, pid);
        const cleanup = new BotAvatarService(
          cleaner.pool,
          f.store,
          undefined,
          () => instant,
        ).cleanup();
        pending.push(cleanup);
        void cleanup.catch(() => undefined);
        await waitForBlocked(cleaner.name, publisherPid);
        await blocker.query('COMMIT');
        const version = await publication;
        expect(await cleanup).toEqual({ retained: 1, deleted: 0, retried: 0 });
        expect(version.configuration.avatarObjectId).toBe(key.objectId);
        expect(await f.service.read(f.access, version.id)).toEqual(png);
        expect(await counts(f.access.botId)).toEqual({ versions: 2, references: 1, audits: 1 });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all([publisher.pool.end(), cleaner.pool.end()]);
      }
    }, 20000);

    it('rejects a queued reference publication once cleanup claims the object, before file deletion', async () => {
      const f = await fixture();
      const key = await orphan(f);
      const publisher = observedPool(),
        cleaner = observedPool();
      const paused = pausedStore(f.store, 'delete');
      const blocker = await admin.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM avatar_objects WHERE id=$1 FOR UPDATE', [key.objectId]);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const cleanup = new BotAvatarService(
          cleaner.pool,
          paused.store,
          undefined,
          () => instant,
        ).cleanup();
        pending.push(cleanup);
        void cleanup.catch(() => undefined);
        const cleanerPid = await waitForBlocked(cleaner.name, pid);
        const publication = restore(publisher.pool, f, key);
        const denied = expect(publication).rejects.toBeInstanceOf(BotAvatarUnavailableError);
        pending.push(denied);
        void denied.catch(() => undefined);
        await waitForBlocked(publisher.name, cleanerPid);
        await blocker.query('COMMIT');
        await boundedReady(paused.entered);
        await denied;
        expect(
          (await admin.query('SELECT state FROM avatar_objects WHERE id=$1', [key.objectId])).rows,
        ).toEqual([{ state: 'deleting' }]);
        expect(await f.store.read(key, png.length)).toEqual(png);
        expect(await counts(f.access.botId)).toEqual({ versions: 1, references: 0, audits: 0 });
        paused.release();
        expect(await cleanup).toEqual({ retained: 0, deleted: 1, retried: 0 });
        await expect(f.store.read(key, png.length)).rejects.toBeInstanceOf(ObjectNotFoundError);
      } finally {
        paused.release();
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all([publisher.pool.end(), cleaner.pool.end()]);
      }
    }, 20000);

    it('enforces exact runtime table and column grants and immutable references even for the owner', async () => {
      const f = await fixture();
      const version = await f.service.upload(f.access, f.versionId, png, 'image/png');
      const tables = ['avatar_objects', 'bot_avatar_references'];
      for (const table of tables)
        for (const privilege of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          expect(
            (
              await admin.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [
                'openbot_runtime',
                table,
                privilege,
              ])
            ).rows[0].allowed,
            `${table} ${privilege}`,
          ).toBe(['SELECT', 'INSERT'].includes(privilege));
        }
      const columns = await admin.query<{ table_name: string; column_name: string }>(
        `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) AND has_column_privilege('openbot_runtime',table_name,column_name,'UPDATE') ORDER BY table_name,column_name`,
        [[...tables, 'bots', 'bot_versions']],
      );
      expect(columns.rows).toEqual([
        { table_name: 'avatar_objects', column_name: 'attempts' },
        { table_name: 'avatar_objects', column_name: 'cleanup_after' },
        { table_name: 'avatar_objects', column_name: 'cleanup_token' },
        { table_name: 'avatar_objects', column_name: 'lease_until' },
        { table_name: 'avatar_objects', column_name: 'state' },
        { table_name: 'bots', column_name: 'current_version_id' },
        { table_name: 'bots', column_name: 'deleted_at' },
        { table_name: 'bots', column_name: 'lifecycle_state' },
        { table_name: 'bots', column_name: 'pre_deleted_state' },
        { table_name: 'bots', column_name: 'recovery_deadline' },
        { table_name: 'bots', column_name: 'visibility' },
      ]);
      for (const query of [
        {
          text: 'UPDATE bot_avatar_references SET object_id=object_id WHERE version_id=$1',
          values: [version.id],
        },
        { text: 'DELETE FROM bot_avatar_references WHERE version_id=$1', values: [version.id] },
        { text: 'TRUNCATE bot_avatar_references', values: [] },
      ]) {
        await expect(runtime.query(query)).rejects.toMatchObject({ code: '42501' });
        await expect(admin.query(query)).rejects.toMatchObject({ code: '55000' });
      }
      await expect(
        runtime.query('UPDATE avatar_objects SET backend_id=$2 WHERE id=$1', [
          version.configuration.avatarObjectId,
          'other-store',
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query('DELETE FROM avatar_objects WHERE id=$1', [
          version.configuration.avatarObjectId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query('ALTER TABLE bot_avatar_references DISABLE TRIGGER ALL'),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await counts(f.access.botId)).toEqual({ versions: 2, references: 1, audits: 1 });
    });
  },
);

async function boundedReady(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture I/O barrier timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

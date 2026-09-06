import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { PostgresApiTokenRepository } from '../../src/api-tokens/postgres-repository.js';
import { ApiTokenService, type ApiTokenScope } from '../../src/api-tokens/service.js';
import { BotAclService } from '../../src/bots/acl-service.js';
import { BotAvatarService } from '../../src/bots/avatar-service.js';
import { BotLifecycleService } from '../../src/bots/lifecycle-service.js';
import { PostgresBotAclRepository } from '../../src/bots/postgres-bot-acl-repository.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotService } from '../../src/bots/service.js';
import { BotVersionService } from '../../src/bots/version-service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { authorizeProviderScope } from '../../src/providers/postgres-provider-scope.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { personalAccess } from '../../src/providers/scope.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

// Run in its own sequential CI command: the deployed provisioner rotates the
// fixed openbot_runtime password. Missing-URL discovery is not native evidence.
const databaseUrl = process.env.TEST_BOT_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('public Bots with deployed PostgreSQL permissions', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl, statement_timeout: 15000 });
  let runtime: pg.Pool;
  const cleanup: Array<() => Promise<unknown>> = [];
  const instant = new Date('2030-01-01T00:00:00.000Z');
  const expiresAt = new Date('2030-01-01T00:01:00.000Z');
  const mutations = ['create', 'update', 'archive'] as const;
  type Mutation = (typeof mutations)[number];
  type Operation = Mutation | 'get' | 'list' | 'versions' | 'version';
  const domainEvent = {
    create: 'bot.created',
    update: 'bot.version_created',
    archive: 'bot.archived',
  } as const;

  beforeAll(async () => {
    await migrateDatabase(admin);
    const url = new URL(databaseUrl!);
    const password = `ci-public-bots-${randomBytes(24).toString('hex')}`;
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
  }, 30000);
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await runtime?.end();
    await admin.end();
  });

  function observedPool() {
    const name = `public-bots-${randomUUID()}`;
    const pool = new pg.Pool({
      connectionString: runtime.options.connectionString,
      application_name: name,
      statement_timeout: 15000,
    });
    cleanup.push(() => pool.end());
    return { name, pool };
  }
  function tokens(pool = runtime, now: () => Date = () => instant) {
    return new ApiTokenService(new PostgresApiTokenRepository(pool), now);
  }
  function acl(pool = runtime) {
    return new BotAclService(new PostgresBotAclRepository(pool));
  }
  function providers() {
    return new ProviderConnections(
      new PostgresProviderRepository(runtime),
      new ProviderSecretBox(randomBytes(32).toString('base64')),
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      {
        // Only upstream capability evidence is a fixture. All HTTP routes,
        // database authority, migrations, runtime grants and transactions are real.
        run: async () => ({
          testedAt: instant.toISOString(),
          text: { ok: true, code: 'passed', raw: 'OK' },
          action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
        }),
      },
    );
  }
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
    'base64',
  );
  async function fixture(withAvatar = false) {
    const actorId = randomUUID(),
      workspaceOwner = randomUUID(),
      workspaceId = randomUUID();
    for (const id of [actorId, workspaceOwner])
      await runtime.query(
        'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,$4)',
        [id, `${id}@example.com`, 'Public Bot member', instant],
      );
    await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,$3)', [
      workspaceId,
      'Public Bot workspace',
      instant,
    ]);
    for (const [id, role] of [
      [actorId, 'member'],
      [workspaceOwner, 'owner'],
    ])
      await runtime.query(
        'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4)',
        [workspaceId, id, role, instant],
      );
    const provider = providers();
    const model = await provider.save(actorId, {
      name: 'Public Bot model',
      baseUrl: 'https://models.example/v1',
      modelId: 'public-bot-model',
      apiKey: 'native-public-bot-provider-secret',
      headers: {},
    });
    const configuration = {
      name: 'Native public assistant',
      roleDescription: 'Assistant',
      instructions: 'Keep the original instructions.',
      modelBinding: {
        scope: { kind: 'personal', id: actorId },
        connectionId: model.id,
        modelId: model.modelId,
      },
    };
    const bots = new BotService(new PostgresBotRepository(runtime, () => instant));
    const bot = await bots.create(actorId, workspaceId, configuration);
    if (!bot.currentVersion) throw new Error('The fixture owner must receive its created version');
    const directory = await mkdtemp(join(tmpdir(), 'openbot-public-bots-native-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new LocalObjectStore(directory);
    const avatars = new BotAvatarService(runtime, store, undefined, () => instant);
    const access = { actorUserId: actorId, workspaceId, botId: bot.id };
    const version = withAvatar
      ? await avatars.upload(access, bot.currentVersion.id, png, 'image/png')
      : bot.currentVersion;
    const avatarBytes = withAvatar ? await avatars.read(access, version.id) : undefined;
    let current = instant;
    const now = () => current;
    const issue = (scopes: ApiTokenScope[], actor = actorId) =>
      tokens(runtime, now).create(actor, workspaceId, {
        name: 'Native public client',
        scopes,
        expiresAt: expiresAt.toISOString(),
      });
    const token = await issue(['bots:read', 'bots:write']);
    const observer = observedPool();
    const app = buildApp({
      apiTokens: tokens(observer.pool, now),
      bots: new BotService(new PostgresBotRepository(observer.pool, now)),
      botVersions: new BotVersionService(
        observer.pool,
        new BotAvatarService(observer.pool, store),
        now,
      ),
      botLifecycle: new BotLifecycleService(observer.pool, now),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    await app.ready();
    return {
      actorId,
      workspaceOwner,
      workspaceId,
      configuration,
      bot,
      version,
      access,
      avatars,
      avatarBytes,
      token,
      observer,
      app,
      issue,
      headers: { authorization: `Bearer ${token.secret}` },
      setTime: (time: Date) => {
        current = time;
      },
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function request(f: Fixture, operation: Operation) {
    if (operation === 'create')
      return f.app.inject({
        method: 'POST',
        url: '/v1/bots',
        headers: f.headers,
        payload: {
          ...f.configuration,
          name: 'Created by public API',
        },
      });
    if (operation === 'update')
      return f.app.inject({
        method: 'PATCH',
        url: `/v1/bots/${f.bot.id}`,
        headers: f.headers,
        payload: {
          expectedCurrentVersionId: f.version.id,
          changes: {
            name: 'Updated by public API',
            modelBinding: f.configuration.modelBinding,
          },
        },
      });
    if (operation === 'archive')
      return f.app.inject({
        method: 'POST',
        url: `/v1/bots/${f.bot.id}/archive`,
        headers: f.headers,
      });
    const url =
      operation === 'list'
        ? '/v1/bots'
        : operation === 'versions'
          ? `/v1/bots/${f.bot.id}/versions`
          : operation === 'version'
            ? `/v1/bots/${f.bot.id}/versions/${f.version.id}`
            : `/v1/bots/${f.bot.id}`;
    return f.app.inject({ url, headers: f.headers });
  }
  function invalidToken(response: Awaited<ReturnType<typeof request>>) {
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: 'invalid_api_token' } });
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.headers['cache-control']).toBe('private, no-store');
  }
  async function snapshot(workspaceId: string) {
    return {
      bots: (
        await admin.query('SELECT * FROM bots WHERE workspace_id=$1 ORDER BY id', [workspaceId])
      ).rows,
      versions: (
        await admin.query(
          'SELECT v.* FROM bot_versions v JOIN bots b ON b.id=v.bot_id WHERE b.workspace_id=$1 ORDER BY v.id',
          [workspaceId],
        )
      ).rows,
      acl: (
        await admin.query(
          'SELECT a.* FROM bot_acl a JOIN bots b ON b.id=a.bot_id WHERE b.workspace_id=$1 ORDER BY a.bot_id,a.user_id',
          [workspaceId],
        )
      ).rows,
      references: (
        await admin.query(
          'SELECT r.* FROM bot_avatar_references r JOIN bot_versions v ON v.id=r.version_id JOIN bots b ON b.id=v.bot_id WHERE b.workspace_id=$1 ORDER BY r.version_id',
          [workspaceId],
        )
      ).rows,
      objects: (
        await admin.query('SELECT * FROM avatar_objects WHERE workspace_id=$1 ORDER BY id', [
          workspaceId,
        ])
      ).rows,
      audits: (
        await admin.query(
          "SELECT * FROM audit_events WHERE event_type LIKE 'bot.%' AND metadata->>'workspaceId'=$1 ORDER BY id",
          [workspaceId],
        )
      ).rows,
    };
  }
  async function usedAudits(f: Fixture) {
    return (
      await admin.query(
        "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='api_token.used' AND metadata->>'tokenId'=$1 ORDER BY id",
        [f.token.token.id],
      )
    ).rows;
  }
  async function waitForBlocked(name: string, blockerPid: number) {
    let pid = 0;
    await vi.waitFor(
      async () => {
        // pg_blocking_pids can omit an advisory holder while the waiter is
        // inside the AFTER INSERT trigger. pg_locks is the same pair, and
        // that pair must stay visible even before wait_event_type='Lock'.
        const result = await admin.query<{ pid: number }>(
          `SELECT a.pid
           FROM pg_stat_activity a
           WHERE a.application_name=$1
             AND a.pid<>$2
             AND (
               (
                 a.wait_event_type='Lock'
                 AND $2=ANY(pg_blocking_pids(a.pid))
               )
               OR EXISTS (
                 SELECT 1
                 FROM pg_locks waiter
                 JOIN pg_locks holder
                   ON holder.locktype=waiter.locktype
                  AND holder.database IS NOT DISTINCT FROM waiter.database
                  AND holder.relation IS NOT DISTINCT FROM waiter.relation
                  AND holder.page IS NOT DISTINCT FROM waiter.page
                  AND holder.tuple IS NOT DISTINCT FROM waiter.tuple
                  AND holder.virtualxid IS NOT DISTINCT FROM waiter.virtualxid
                  AND holder.transactionid IS NOT DISTINCT FROM waiter.transactionid
                  AND holder.classid IS NOT DISTINCT FROM waiter.classid
                  AND holder.objid IS NOT DISTINCT FROM waiter.objid
                  AND holder.objsubid IS NOT DISTINCT FROM waiter.objsubid
                  AND holder.granted
                  AND NOT waiter.granted
                  AND holder.pid=$2
                  AND waiter.pid=a.pid
               )
             )`,
          [name, blockerPid],
        );
        expect(result.rows).toHaveLength(1);
        pid = result.rows[0]!.pid;
      },
      { timeout: 5000, interval: 20 },
    );
    return pid;
  }
  async function transactionBarrier(lock: (connection: pg.PoolClient) => Promise<unknown>) {
    const blocker = await runtime.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await blocker.query('COMMIT');
      } finally {
        blocker.release();
      }
    };
    cleanup.push(release);
    await blocker.query('BEGIN');
    await lock(blocker);
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    return { pid, release };
  }
  async function auditBarrier(
    f: Fixture,
    event:
      'api_token.used' | 'api_token.revoked' | 'bot.acl_revoked' | (typeof domainEvent)[Mutation],
    revokeInsideTransaction = false,
  ) {
    const name = `api02_audit_${randomUUID().replaceAll('-', '')}`;
    const key = randomBytes(4).readInt32BE(0);
    const blocker = await admin.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await blocker.query('SELECT pg_advisory_unlock($1,$2)', [739202, key]);
      } finally {
        blocker.release();
      }
    };
    cleanup.push(async () => {
      await release();
      await admin.query(`DROP TRIGGER IF EXISTS ${name} ON audit_events`);
      await admin.query(`DROP FUNCTION IF EXISTS ${name}()`);
    });
    // UUIDs and event names are server-created fixture constants. The invoker
    // trigger uses the resource transaction and the deployed runtime grants.
    await admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.event_type='${event}' AND NEW.metadata->>'workspaceId'='${f.workspaceId}' THEN
          ${revokeInsideTransaction ? `UPDATE api_tokens SET revoked_at='${instant.toISOString()}' WHERE id='${f.token.token.id}';` : ''}
          PERFORM pg_advisory_xact_lock(739202,${key});
        END IF;
        RETURN NEW;
      END;
      $body$`);
    await admin.query(
      `CREATE TRIGGER ${name} AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    await blocker.query('SELECT pg_advisory_lock($1,$2)', [739202, key]);
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    return { pid, release };
  }

  it('creates, edits and archives through actual Fastify services as the restricted runtime role', async () => {
    const f = await fixture();
    expect((await runtime.query('SELECT current_user AS role')).rows).toEqual([
      { role: 'openbot_runtime' },
    ]);
    expect(
      (
        await admin.query(
          "SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='openbot_runtime'",
        )
      ).rows,
    ).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }]);
    const columns = await admin.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='api_tokens' AND has_column_privilege('openbot_runtime','api_tokens',column_name,'UPDATE') ORDER BY column_name",
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      'last_used_at',
      'revoked_at',
    ]);
    expect(
      (
        await admin.query(
          "SELECT has_table_privilege('openbot_runtime','audit_events','SELECT') AS can_read,has_table_privilege('openbot_runtime','audit_events','INSERT') AS can_append",
        )
      ).rows,
    ).toEqual([{ can_read: false, can_append: true }]);
    const created = await request(f, 'create');
    expect(created.statusCode).toBe(201);
    const { bot } = created.json<{ bot: { id: string; currentVersion: { id: string } } }>();
    expect(created.json()).toMatchObject({
      bot: {
        workspaceId: f.workspaceId,
        visibility: 'private',
        lifecycleState: 'active',
        accessRole: 'owner',
        currentVersion: { number: 1, author: { id: f.actorId } },
      },
    });
    expect(
      (await runtime.query('SELECT user_id,role FROM bot_acl WHERE bot_id=$1', [bot.id])).rows,
    ).toEqual([{ user_id: f.actorId, role: 'owner' }]);
    const edited = await f.app.inject({
      method: 'PATCH',
      url: `/v1/bots/${bot.id}`,
      headers: f.headers,
      payload: {
        expectedCurrentVersionId: bot.currentVersion.id,
        changes: { name: 'Public second version' },
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      version: {
        number: 2,
        author: { id: f.actorId },
        configuration: { name: 'Public second version' },
      },
    });
    const archived = await f.app.inject({
      method: 'POST',
      url: `/v1/bots/${bot.id}/archive`,
      headers: f.headers,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ lifecycle: { botId: bot.id, state: 'archived' } });
    const inspected = await f.app.inject({ url: `/v1/bots/${bot.id}`, headers: f.headers });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({
      bot: { lifecycleState: 'archived', currentVersion: edited.json().version },
    });
    expect(
      (
        await admin.query(
          "SELECT event_type FROM audit_events WHERE metadata->>'botId'=$1 ORDER BY event_type",
          [bot.id],
        )
      ).rows,
    ).toEqual([
      { event_type: 'bot.archived' },
      { event_type: 'bot.created' },
      { event_type: 'bot.version_created' },
    ]);
    expect(JSON.stringify(await snapshot(f.workspaceId))).not.toContain(
      'native-public-bot-provider-secret',
    );
  }, 20000);

  it.each(mutations)(
    'checks expiry after the mandatory %s audit and rolls back every domain record',
    async (operation) => {
      const f = await fixture(true);
      const before = await snapshot(f.workspaceId);
      expect(before.references).toHaveLength(1);
      const barrier = await auditBarrier(f, domainEvent[operation]);
      const pending = request(f, operation);
      void pending.catch(() => undefined);
      try {
        await waitForBlocked(f.observer.name, barrier.pid);
        // The AFTER INSERT barrier selects this domain audit, not api_token.used.
        expect(await usedAudits(f)).toEqual([
          {
            actor_user_id: f.actorId,
            metadata: {
              tokenId: f.token.token.id,
              workspaceId: f.workspaceId,
              scope: 'bots:write',
              outcome: 'allowed',
            },
          },
        ]);
        expect(await snapshot(f.workspaceId)).toEqual(before);
        f.setTime(expiresAt);
        await barrier.release();
        invalidToken(await pending);
        expect(await snapshot(f.workspaceId)).toEqual(before);
        expect(await f.avatars.read(f.access, f.version.id)).toEqual(f.avatarBytes);
        expect(
          (
            await runtime.query('SELECT last_used_at,revoked_at FROM api_tokens WHERE id=$1', [
              f.token.token.id,
            ])
          ).rows,
        ).toEqual([{ last_used_at: instant, revoked_at: null }]);
      } finally {
        await barrier.release();
        await pending.catch(() => undefined);
      }
    },
    20000,
  );

  it.each(mutations)(
    'uses the same resource SqlConnection for final %s token admission and atomic rollback',
    async (operation) => {
      const f = await fixture(true);
      const before = await snapshot(f.workspaceId);
      // The audit trigger revokes only inside the open resource transaction.
      // Another connection cannot see that uncommitted change. A guard on a
      // second connection either misses it or waits on the held workspace lock.
      const barrier = await auditBarrier(f, domainEvent[operation], true);
      const pending = request(f, operation);
      void pending.catch(() => undefined);
      try {
        await waitForBlocked(f.observer.name, barrier.pid);
        expect(await usedAudits(f)).toHaveLength(1);
        expect(
          (await runtime.query('SELECT revoked_at FROM api_tokens WHERE id=$1', [f.token.token.id]))
            .rows,
        ).toEqual([{ revoked_at: null }]);
        expect(await snapshot(f.workspaceId)).toEqual(before);
        await barrier.release();
        invalidToken(await pending);
        expect(await snapshot(f.workspaceId)).toEqual(before);
        expect(
          (await runtime.query('SELECT revoked_at FROM api_tokens WHERE id=$1', [f.token.token.id]))
            .rows,
        ).toEqual([{ revoked_at: null }]);
        expect(await f.avatars.read(f.access, f.version.id)).toEqual(f.avatarBytes);
      } finally {
        await barrier.release();
        await pending.catch(() => undefined);
      }
    },
    20000,
  );

  it.each(['get', 'update', 'archive', 'versions', 'version'] as const)(
    'denies an expired %s after waiting on the actual Bot row',
    async (operation) => {
      const f = await fixture();
      const before = await snapshot(f.workspaceId);
      const barrier = await transactionBarrier((connection) =>
        connection.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [f.bot.id]),
      );
      const pending = request(f, operation);
      void pending.catch(() => undefined);
      try {
        await waitForBlocked(f.observer.name, barrier.pid);
        expect(await usedAudits(f)).toHaveLength(1);
        f.setTime(expiresAt);
        await barrier.release();
        invalidToken(await pending);
        expect(await snapshot(f.workspaceId)).toEqual(before);
      } finally {
        await barrier.release();
        await pending.catch(() => undefined);
      }
    },
    20000,
  );

  it.each(['create', 'update', 'get', 'list'] as const)(
    'denies an expired %s after waiting on actual actor provider admission',
    async (operation) => {
      const f = await fixture();
      const before = await snapshot(f.workspaceId);
      const barrier = await transactionBarrier((connection) =>
        authorizeProviderScope(connection, personalAccess(f.actorId), 'manage'),
      );
      const pending = request(f, operation);
      void pending.catch(() => undefined);
      try {
        await waitForBlocked(f.observer.name, barrier.pid);
        expect(await usedAudits(f)).toHaveLength(1);
        f.setTime(expiresAt);
        await barrier.release();
        invalidToken(await pending);
        expect(await snapshot(f.workspaceId)).toEqual(before);
      } finally {
        await barrier.release();
        await pending.catch(() => undefined);
      }
    },
    20000,
  );

  it('rolls back the carried avatar reference when update expires while waiting on its object row', async () => {
    const f = await fixture(true);
    const before = await snapshot(f.workspaceId);
    expect(before.references).toHaveLength(1);
    const objectId = f.version.configuration.avatarObjectId;
    expect(objectId).toBeTypeOf('string');
    const barrier = await transactionBarrier((connection) =>
      connection.query('SELECT id FROM avatar_objects WHERE id=$1 FOR UPDATE', [objectId]),
    );
    const pending = request(f, 'update');
    void pending.catch(() => undefined);
    try {
      await waitForBlocked(f.observer.name, barrier.pid);
      expect(await usedAudits(f)).toHaveLength(1);
      f.setTime(expiresAt);
      await barrier.release();
      invalidToken(await pending);
      expect(await snapshot(f.workspaceId)).toEqual(before);
      expect(await f.avatars.read(f.access, f.version.id)).toEqual(f.avatarBytes);
    } finally {
      await barrier.release();
      await pending.catch(() => undefined);
    }
  }, 20000);

  it.each(['create', 'update', 'archive', 'get', 'list', 'versions', 'version'] as const)(
    'denies queued %s after real token revocation commits ahead of resource admission',
    async (operation) => {
      const f = await fixture(true);
      const before = await snapshot(f.workspaceId);
      const authentication = await auditBarrier(f, 'api_token.used');
      const revocation = await auditBarrier(f, 'api_token.revoked');
      const revoker = observedPool();
      const pending = request(f, operation);
      void pending.catch(() => undefined);
      let revoked: Promise<void> | undefined;
      try {
        const authenticationPid = await waitForBlocked(f.observer.name, authentication.pid);
        // Queue the real revoker while authentication still owns the workspace.
        // It must acquire that lock before the subsequent resource transaction.
        revoked = tokens(revoker.pool).revoke(f.actorId, f.workspaceId, f.token.token.id);
        void revoked.catch(() => undefined);
        await waitForBlocked(revoker.name, authenticationPid);
        await authentication.release();
        const revokerPid = await waitForBlocked(revoker.name, revocation.pid);
        await waitForBlocked(f.observer.name, revokerPid);
        expect(await usedAudits(f)).toHaveLength(1);
        expect(await snapshot(f.workspaceId)).toEqual(before);
        await revocation.release();
        await revoked;
        invalidToken(await pending);
        expect(await snapshot(f.workspaceId)).toEqual(before);
        expect(
          (await runtime.query('SELECT revoked_at FROM api_tokens WHERE id=$1', [f.token.token.id]))
            .rows,
        ).toEqual([{ revoked_at: instant }]);
        expect(
          (
            await admin.query(
              "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='api_token.revoked' AND metadata->>'tokenId'=$1",
              [f.token.token.id],
            )
          ).rows,
        ).toEqual([
          {
            actor_user_id: f.actorId,
            metadata: { tokenId: f.token.token.id, workspaceId: f.workspaceId, reason: 'creator' },
          },
        ]);
      } finally {
        await authentication.release();
        await revocation.release();
        await pending.catch(() => undefined);
        await revoked?.catch(() => undefined);
      }
    },
    25000,
  );

  it('holds token and workspace authority through provider and domain-audit waits before queued real revocation', async () => {
    const f = await fixture(true);
    const before = await snapshot(f.workspaceId);
    const provider = await transactionBarrier((connection) =>
      authorizeProviderScope(connection, personalAccess(f.actorId), 'manage'),
    );
    const domainAudit = await auditBarrier(f, 'bot.version_created');
    const revoker = observedPool();
    const pending = request(f, 'update');
    void pending.catch(() => undefined);
    let revoked: Promise<void> | undefined;
    try {
      const writerPid = await waitForBlocked(f.observer.name, provider.pid);
      revoked = tokens(revoker.pool).revoke(f.actorId, f.workspaceId, f.token.token.id);
      void revoked.catch(() => undefined);
      await waitForBlocked(revoker.name, writerPid);
      await provider.release();
      expect(await waitForBlocked(f.observer.name, domainAudit.pid)).toBe(writerPid);
      await waitForBlocked(revoker.name, writerPid);
      expect(await usedAudits(f)).toHaveLength(1);
      expect(await snapshot(f.workspaceId)).toEqual(before);
      await domainAudit.release();
      const response = await pending;
      expect(response.statusCode).toBe(200);
      const { version } = response.json<{ version: { id: string } }>();
      await revoked;
      const after = await snapshot(f.workspaceId);
      expect(after.bots).toEqual([
        {
          ...before.bots[0],
          current_version_id: version.id,
        },
      ]);
      expect(after.versions).toHaveLength(before.versions.length + 1);
      expect(after.references).toHaveLength(before.references.length + 1);
      expect(after.objects).toEqual(before.objects);
      expect(after.acl).toEqual(before.acl);
      expect(
        after.audits.filter((event) => event.event_type === 'bot.version_created'),
      ).toHaveLength(2);
      invalidToken(await request(f, 'get'));
    } finally {
      await provider.release();
      await domainAudit.release();
      await pending.catch(() => undefined);
      await revoked?.catch(() => undefined);
    }
  }, 25000);

  it('intersects scopes with the current creator ACL without granting workspace owners Bot ownership', async () => {
    const f = await fixture();
    const ownerToken = await f.issue(['bots:read', 'bots:write'], f.workspaceOwner);
    const ownerHeaders = { authorization: `Bearer ${ownerToken.secret}` };
    for (const url of [`/v1/bots/${f.bot.id}`, `/v1/bots/${f.bot.id}/versions`]) {
      const denied = await f.app.inject({ url, headers: ownerHeaders });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: { code: 'bot_forbidden' } });
    }
    const readOnly = await f.issue(['bots:read']);
    const writeOnly = await f.issue(['bots:write']);
    const writeDenied = await f.app.inject({
      method: 'PATCH',
      url: `/v1/bots/${f.bot.id}`,
      headers: { authorization: `Bearer ${readOnly.secret}` },
      payload: { expectedCurrentVersionId: f.version.id, changes: { name: 'Scope cannot write' } },
    });
    const readDenied = await f.app.inject({
      url: `/v1/bots/${f.bot.id}`,
      headers: { authorization: `Bearer ${writeOnly.secret}` },
    });
    for (const response of [writeDenied, readDenied]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'insufficient_scope' } });
    }
    await acl().grant(f.actorId, f.workspaceId, f.bot.id, {
      userId: f.workspaceOwner,
      role: 'editor',
    });
    const edited = await f.app.inject({
      method: 'PATCH',
      url: `/v1/bots/${f.bot.id}`,
      headers: ownerHeaders,
      payload: {
        expectedCurrentVersionId: f.version.id,
        changes: { name: 'Actual current editor' },
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      version: { number: 2, author: { id: f.workspaceOwner } },
    });
    const archived = await f.app.inject({
      method: 'POST',
      url: `/v1/bots/${f.bot.id}/archive`,
      headers: ownerHeaders,
    });
    expect(archived.statusCode).toBe(403);
    expect(archived.json()).toEqual({ error: { code: 'bot_forbidden' } });
    await acl().revoke(f.actorId, f.workspaceId, f.bot.id, f.workspaceOwner);
    const removed = await f.app.inject({ url: `/v1/bots/${f.bot.id}`, headers: ownerHeaders });
    expect(removed.statusCode).toBe(403);
    expect(removed.json()).toEqual({ error: { code: 'bot_forbidden' } });
  }, 20000);

  it('uses the persisted token creator for model rights and its bound workspace for discovery', async () => {
    const f = await fixture();
    const otherWorkspace = randomUUID();
    await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,$3)', [
      otherWorkspace,
      'Other public Bot workspace',
      instant,
    ]);
    await runtime.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)",
      [otherWorkspace, f.actorId, instant],
    );
    const otherBot = await new BotService(new PostgresBotRepository(runtime, () => instant)).create(
      f.actorId,
      otherWorkspace,
      { ...f.configuration, name: 'Other workspace Bot' },
    );
    const denied = await f.app.inject({ url: `/v1/bots/${otherBot.id}`, headers: f.headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: { code: 'bot_forbidden' } });
    const discovered = await request(f, 'list');
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toMatchObject({
      bots: [{ id: f.bot.id, workspaceId: f.workspaceId }],
      nextAfter: null,
    });
    expect(discovered.json().bots).toHaveLength(1);
    const ownerToken = await f.issue(['bots:write'], f.workspaceOwner);
    const before = await snapshot(f.workspaceId);
    const forbiddenModel = await f.app.inject({
      method: 'POST',
      url: '/v1/bots',
      headers: { authorization: `Bearer ${ownerToken.secret}` },
      payload: f.configuration,
    });
    expect(forbiddenModel.statusCode).toBe(400);
    expect(forbiddenModel.json()).toEqual({
      error: { code: 'bot_model_unavailable', reason: 'not-accessible' },
    });
    expect(await snapshot(f.workspaceId)).toEqual(before);
  }, 20000);

  it('rejects a removed creator token even after workspace rejoining restores retained direct Bot access', async () => {
    const f = await fixture();
    await acl().grant(f.actorId, f.workspaceId, f.bot.id, {
      userId: f.workspaceOwner,
      role: 'owner',
    });
    await new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(runtime)).remove(
      f.workspaceOwner,
      f.workspaceId,
      f.actorId,
    );
    invalidToken(await request(f, 'get'));
    await runtime.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'member',$3)",
      [f.workspaceId, f.actorId, instant],
    );
    invalidToken(await request(f, 'get'));
    const fresh = await f.issue(['bots:read']);
    const admitted = await f.app.inject({
      url: `/v1/bots/${f.bot.id}`,
      headers: { authorization: `Bearer ${fresh.secret}` },
    });
    expect(admitted.statusCode).toBe(200);
    expect(admitted.json()).toMatchObject({
      bot: { id: f.bot.id, accessRole: 'owner', currentVersion: { id: f.version.id } },
    });
  }, 20000);

  it('denies a queued edit after a real owner ACL revocation wins the workspace lock', async () => {
    const f = await fixture(true);
    await acl().grant(f.actorId, f.workspaceId, f.bot.id, {
      userId: f.workspaceOwner,
      role: 'owner',
    });
    const before = await snapshot(f.workspaceId);
    const authentication = await auditBarrier(f, 'api_token.used');
    const revocation = await auditBarrier(f, 'bot.acl_revoked');
    const revoker = observedPool();
    const pending = request(f, 'update');
    void pending.catch(() => undefined);
    let revoked: Promise<void> | undefined;
    try {
      const authenticationPid = await waitForBlocked(f.observer.name, authentication.pid);
      revoked = acl(revoker.pool).revoke(f.workspaceOwner, f.workspaceId, f.bot.id, f.actorId);
      void revoked.catch(() => undefined);
      await waitForBlocked(revoker.name, authenticationPid);
      await authentication.release();
      const revokerPid = await waitForBlocked(revoker.name, revocation.pid);
      await waitForBlocked(f.observer.name, revokerPid);
      expect(await usedAudits(f)).toHaveLength(1);
      await revocation.release();
      await revoked;
      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'bot_forbidden' } });
      const after = await snapshot(f.workspaceId);
      expect(after.bots).toEqual(before.bots);
      expect(after.versions).toEqual(before.versions);
      expect(after.references).toEqual(before.references);
      expect(after.objects).toEqual(before.objects);
      expect(after.acl).toEqual(before.acl.filter((grant) => grant.user_id !== f.actorId));
      expect(after.audits.filter((event) => event.event_type !== 'bot.acl_revoked')).toEqual(
        before.audits,
      );
      expect(after.audits.filter((event) => event.event_type === 'bot.acl_revoked')).toHaveLength(
        1,
      );
      expect(
        (await runtime.query('SELECT revoked_at FROM api_tokens WHERE id=$1', [f.token.token.id]))
          .rows,
      ).toEqual([{ revoked_at: null }]);
    } finally {
      await authentication.release();
      await revocation.release();
      await pending.catch(() => undefined);
      await revoked?.catch(() => undefined);
    }
  }, 25000);

  it.each(['update', 'archive'] as const)(
    'checks token expiry before returning an idempotent %s after a resource wait',
    async (operation) => {
      const f = await fixture();
      if (operation === 'archive')
        await new BotLifecycleService(runtime, () => instant).archive(
          f.actorId,
          f.workspaceId,
          f.bot.id,
        );
      const before = await snapshot(f.workspaceId);
      const barrier = await transactionBarrier((connection) =>
        connection.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [f.bot.id]),
      );
      const pending =
        operation === 'archive'
          ? request(f, operation)
          : f.app.inject({
              method: 'PATCH',
              url: `/v1/bots/${f.bot.id}`,
              headers: f.headers,
              payload: {
                expectedCurrentVersionId: f.version.id,
                changes: { name: f.configuration.name },
              },
            });
      void pending.catch(() => undefined);
      try {
        await waitForBlocked(f.observer.name, barrier.pid);
        expect(await usedAudits(f)).toHaveLength(1);
        f.setTime(expiresAt);
        await barrier.release();
        invalidToken(await pending);
        expect(await snapshot(f.workspaceId)).toEqual(before);
      } finally {
        await barrier.release();
        await pending.catch(() => undefined);
      }
    },
    20000,
  );
});

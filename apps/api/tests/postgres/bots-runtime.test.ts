import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotAccessError, BotService } from '../../src/bots/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { authorizeProviderScope } from '../../src/providers/postgres-provider-scope.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { personalAccess } from '../../src/providers/scope.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

// The real provisioner changes the fixed runtime role password. This URL must
// target its own disposable PostgreSQL service, not the auth/provider/OIDC job.
const databaseUrl = process.env.TEST_BOT_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Bot identity with the deployed restricted role', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let runtime: pg.Pool;
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
  async function workspaceCounts(workspaceId: string) {
    return (
      await admin.query(
        `SELECT (SELECT COUNT(*)::int FROM bots WHERE workspace_id=$1) AS bots,
        (SELECT COUNT(*)::int FROM bot_versions v JOIN bots b ON b.id=v.bot_id WHERE b.workspace_id=$1) AS versions,
        (SELECT COUNT(*)::int FROM bot_acl a JOIN bots b ON b.id=a.bot_id WHERE b.workspace_id=$1) AS acl,
        (SELECT COUNT(*)::int FROM audit_events WHERE event_type='bot.created' AND metadata->>'workspaceId'=$1::text) AS audits`,
        [workspaceId],
      )
    ).rows[0];
  }

  it('defers the same-Bot current-version constraint until commit and rejects a different Bot version', async () => {
    const f = await fixture();
    const service = new BotService(new PostgresBotRepository(runtime));
    const first = await service.create(f.actorId, f.workspaceId, f.input);
    const second = await service.create(f.actorId, f.workspaceId, f.input);
    expect(first.currentVersion?.number).toBe(1);
    expect((await service.list(f.actorId, f.workspaceId)).map((bot) => bot.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(await service.list(f.ownerId, f.workspaceId)).toEqual([]);
    await expect(service.get(f.ownerId, f.workspaceId, first.id)).rejects.toBeInstanceOf(
      BotAccessError,
    );
    const connection = await runtime.connect();
    try {
      await connection.query('BEGIN');
      // The statement must succeed: checking only that an UPDATE fails would
      // not prove the native deferred commit boundary used by initial creation.
      expect(
        (
          await connection.query('UPDATE bots SET current_version_id=$2 WHERE id=$1', [
            first.id,
            second.currentVersion!.id,
          ])
        ).rowCount,
      ).toBe(1);
      await expect(connection.query('COMMIT')).rejects.toMatchObject({
        code: '23503',
        constraint: 'bots_current_version_same_bot',
      });
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
    expect((await service.get(f.actorId, f.workspaceId, first.id)).currentVersion?.id).toBe(
      first.currentVersion!.id,
    );
  });

  it('enforces immutable versions even for the table owner and exact narrow runtime privileges', async () => {
    const f = await fixture();
    const bot = await new BotService(new PostgresBotRepository(runtime)).create(
      f.actorId,
      f.workspaceId,
      f.input,
    );
    const tables = ['bots', 'bot_versions', 'bot_acl'];
    for (const table of tables) {
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
              table,
              privilege,
            ])
          ).rows[0].allowed,
          `${table} ${privilege}`,
        ).toBe(
          ['SELECT', 'INSERT'].includes(privilege) ||
            (table === 'bot_acl' && privilege === 'DELETE'),
        );
    }
    const columns = await admin.query<{
      table_name: string;
      column_name: string;
      allowed: boolean;
    }>(
      `SELECT table_name,column_name,has_column_privilege('openbot_runtime',table_name,column_name,'UPDATE') AS allowed
       FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`,
      [tables],
    );
    expect(
      columns.rows
        .filter((column) => column.allowed)
        .sort((a, b) =>
          `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`),
        ),
    ).toEqual([
      { table_name: 'bot_acl', column_name: 'role', allowed: true },
      { table_name: 'bots', column_name: 'current_version_id', allowed: true },
      { table_name: 'bots', column_name: 'deleted_at', allowed: true },
      { table_name: 'bots', column_name: 'lifecycle_state', allowed: true },
      { table_name: 'bots', column_name: 'pre_deleted_state', allowed: true },
      { table_name: 'bots', column_name: 'recovery_deadline', allowed: true },
      { table_name: 'bots', column_name: 'visibility', allowed: true },
    ]);
    expect(
      (
        await admin.query(
          "SELECT has_function_privilege('openbot_runtime','reject_bot_version_mutation()','EXECUTE') AS allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
    for (const query of [
      {
        text: "UPDATE bot_versions SET rationale='rewritten' WHERE id=$1",
        values: [bot.currentVersion!.id],
      },
      { text: 'DELETE FROM bot_versions WHERE id=$1', values: [bot.currentVersion!.id] },
      { text: 'TRUNCATE bot_versions CASCADE', values: [] },
    ]) {
      await expect(runtime.query(query)).rejects.toMatchObject({ code: '42501' });
      await expect(admin.query(query)).rejects.toMatchObject({
        code: '55000',
        message: 'bot_versions is immutable',
      });
    }
    await expect(
      runtime.query('ALTER TABLE bot_versions DISABLE TRIGGER ALL'),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await workspaceCounts(f.workspaceId)).toEqual({
      bots: 1,
      versions: 1,
      acl: 1,
      audits: 1,
    });
  });

  it('rolls back the Bot, version and owner grant when mandatory creation auditing fails', async () => {
    const f = await fixture();
    const service = new BotService(new PostgresBotRepository(runtime));
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(service.create(f.actorId, f.workspaceId, f.input)).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(await workspaceCounts(f.workspaceId)).toEqual({
      bots: 0,
      versions: 0,
      acl: 0,
      audits: 0,
    });
    await service.create(f.actorId, f.workspaceId, f.input);
    expect(await workspaceCounts(f.workspaceId)).toEqual({
      bots: 1,
      versions: 1,
      acl: 1,
      audits: 1,
    });
  });

  it.each(['disable', 'remove-member'] as const)(
    'rejects pending creation after %s wins admission and commits',
    async (mutation) => {
      const f = await fixture();
      const creator = observedPool(),
        writer = observedPool();
      const now = vi.fn(() => new Date());
      const service = new BotService(new PostgresBotRepository(creator.pool, now));
      const blocker = await admin.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const change =
          mutation === 'disable'
            ? providers(writer.pool).disable(f.actorId, f.model.id)
            : new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(writer.pool)).remove(
                f.ownerId,
                f.workspaceId,
                f.actorId,
              );
        pending.push(change);
        void change.catch(() => undefined);
        const writerPid = await waitForBlocked(writer.name, blockerPid);
        const rejected = expect(service.create(f.actorId, f.workspaceId, f.input)).rejects;
        const creation =
          mutation === 'disable'
            ? rejected.toMatchObject({ reason: 'disabled' })
            : rejected.toBeInstanceOf(BotAccessError);
        pending.push(creation);
        void creation.catch(() => undefined);
        await waitForBlocked(creator.name, writerPid);
        expect(now).not.toHaveBeenCalled();
        await blocker.query('COMMIT');
        await Promise.all(pending);
        expect(now).not.toHaveBeenCalled();
        expect(await workspaceCounts(f.workspaceId)).toEqual({
          bots: 0,
          versions: 0,
          acl: 0,
          audits: 0,
        });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all([creator.pool.end(), writer.pool.end()]);
      }
    },
    20000,
  );

  it.each(['disable', 'remove-member'] as const)(
    'holds admitted creation through commit before a pending %s, retaining identity afterward',
    async (mutation) => {
      const f = await fixture();
      const creator = observedPool(),
        writer = observedPool();
      const service = new BotService(new PostgresBotRepository(creator.pool));
      const blocker = await admin.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const creation = service.create(f.actorId, f.workspaceId, f.input);
        pending.push(creation);
        void creation.catch(() => undefined);
        const creatorPid = await waitForBlocked(creator.name, blockerPid);
        const change =
          mutation === 'disable'
            ? providers(writer.pool).disable(f.actorId, f.model.id)
            : new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(writer.pool)).remove(
                f.ownerId,
                f.workspaceId,
                f.actorId,
              );
        pending.push(change);
        void change.catch(() => undefined);
        await waitForBlocked(writer.name, creatorPid);
        await blocker.query('COMMIT');
        const bot = await creation;
        await change;
        expect(await workspaceCounts(f.workspaceId)).toEqual({
          bots: 1,
          versions: 1,
          acl: 1,
          audits: 1,
        });
        if (mutation === 'disable')
          expect((await service.get(f.actorId, f.workspaceId, bot.id)).bindingStatus).toEqual({
            state: 'unavailable',
            reason: 'disabled',
          });
        else
          await expect(service.get(f.actorId, f.workspaceId, bot.id)).rejects.toBeInstanceOf(
            BotAccessError,
          );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all([creator.pool.end(), writer.pool.end()]);
      }
    },
    20000,
  );

  it('samples one fresh timestamp only after model admission for Bot, version, owner grant and audit', async () => {
    const f = await fixture();
    const creator = observedPool();
    let instant = new Date('2030-01-01T00:00:00.000Z');
    const now = vi.fn(() => instant);
    const service = new BotService(new PostgresBotRepository(creator.pool, now));
    const blocker = await runtime.connect();
    let pending: ReturnType<BotService['create']> | undefined;
    try {
      await blocker.query('BEGIN');
      await authorizeProviderScope(blocker, personalAccess(f.actorId), 'manage');
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = service.create(f.actorId, f.workspaceId, f.input);
      void pending.catch(() => undefined);
      await waitForBlocked(creator.name, blockerPid);
      expect(now).not.toHaveBeenCalled();
      instant = new Date('2030-01-01T00:05:00.000Z');
      await blocker.query('COMMIT');
      const bot = await pending;
      expect(now).toHaveBeenCalledTimes(1);
      expect(bot.currentVersion?.createdAt).toEqual(instant);
      const persisted = await admin.query(
        `SELECT b.created_at AS bot,v.created_at AS version,a.created_at AS acl,e.occurred_at AS audit
         FROM bots b JOIN bot_versions v ON v.id=b.current_version_id
         JOIN bot_acl a ON a.bot_id=b.id
         JOIN audit_events e ON e.metadata->>'botId'=b.id::text AND e.event_type='bot.created'
         WHERE b.id=$1`,
        [bot.id],
      );
      expect(persisted.rows).toEqual([
        { bot: instant, version: instant, acl: instant, audit: instant },
      ]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending?.catch(() => undefined);
      await creator.pool.end();
    }
  }, 20000);
});

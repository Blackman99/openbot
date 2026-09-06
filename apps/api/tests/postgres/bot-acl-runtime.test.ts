import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BotAclService, LastBotOwnerError } from '../../src/bots/acl-service.js';
import { PostgresBotAclRepository } from '../../src/bots/postgres-bot-acl-repository.js';
import { lockAuthorizedBot } from '../../src/bots/postgres-bot-access.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotAccessError, BotService } from '../../src/bots/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

// Run after bots-runtime.test.ts in a separate vitest command. Both provision
// the fixed runtime role and must never race its password on the same server.
const databaseUrl = process.env.TEST_BOT_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Bot ACL with deployed PostgreSQL permissions', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let runtime: pg.Pool;
  const acl = (pool = runtime) => new BotAclService(new PostgresBotAclRepository(pool));
  beforeAll(async () => {
    await migrateDatabase(admin);
    const url = new URL(databaseUrl!);
    const password = `ci-bot-acl-${randomBytes(24).toString('hex')}`;
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
  async function fixture(twoOwners = false) {
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
    if (twoOwners)
      await acl().grant(first, workspaceId, bot.id, { userId: workspaceOwner, role: 'owner' });
    return { workspaceId, workspaceOwner, first, second: workspaceOwner, target, bot };
  }
  function observedPool() {
    const name = `bot-acl-${randomUUID()}`;
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
        await admin.query('SELECT * FROM bot_versions WHERE bot_id=$1 ORDER BY version', [botId])
      ).rows,
      acl: (await admin.query('SELECT * FROM bot_acl WHERE bot_id=$1 ORDER BY user_id', [botId]))
        .rows,
      audits: (
        await admin.query("SELECT * FROM audit_events WHERE metadata->>'botId'=$1 ORDER BY id", [
          botId,
        ])
      ).rows,
    };
  }
  it('performs ACL and visibility changes with narrow grants while immutable identity columns remain denied', async () => {
    const f = await fixture();
    await acl().grant(f.first, f.workspaceId, f.bot.id, { userId: f.target });
    await acl().changeRole(f.first, f.workspaceId, f.bot.id, f.target, { role: 'editor' });
    await acl().changeVisibility(f.first, f.workspaceId, f.bot.id, { visibility: 'workspace' });
    expect(
      (await acl().list(f.first, f.workspaceId, f.bot.id)).find(
        (member) => member.user.id === f.target,
      )?.role,
    ).toBe('editor');
    for (const statement of [
      'UPDATE bots SET created_by_user_id=created_by_user_id WHERE id=$1',
      'UPDATE bots SET workspace_id=workspace_id WHERE id=$1',
      'UPDATE bots SET id=id WHERE id=$1',
      'DELETE FROM bots WHERE id=$1',
      'UPDATE bot_acl SET created_at=created_at WHERE bot_id=$1',
      'UPDATE bot_acl SET user_id=user_id WHERE bot_id=$1',
      'UPDATE bot_acl SET bot_id=bot_id WHERE bot_id=$1',
    ])
      await expect(runtime.query(statement, [f.bot.id])).rejects.toMatchObject({ code: '42501' });
    await acl().revoke(f.first, f.workspaceId, f.bot.id, f.target);
    expect((await snapshot(f.bot.id)).versions).toHaveLength(1);
    expect((await snapshot(f.bot.id)).audits.map((event) => event.event_type).sort()).toEqual(
      [
        'bot.created',
        'bot.acl_granted',
        'bot.acl_role_changed',
        'bot.acl_revoked',
        'bot.visibility_changed',
      ].sort(),
    );
  });
  it('serializes concurrent owner self-demotions and retains one currently eligible owner', async () => {
    const f = await fixture(true);
    const outcomes = await Promise.allSettled(
      [f.first, f.second].map((actor) =>
        acl().changeRole(actor, f.workspaceId, f.bot.id, actor, { role: 'user' }),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason instanceof LastBotOwnerError).toBe(
      true,
    );
    expect(
      (
        await admin.query(
          "SELECT COUNT(*)::int AS count FROM bot_acl a JOIN workspace_memberships m ON m.user_id=a.user_id AND m.workspace_id=$1 WHERE a.bot_id=$2 AND a.role='owner'",
          [f.workspaceId, f.bot.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (await snapshot(f.bot.id)).audits.filter(
        (event) => event.event_type === 'bot.acl_role_changed',
      ),
    ).toHaveLength(1);
  });
  it('serializes reciprocal owner revocation and rechecks the waiting actor', async () => {
    const f = await fixture(true);
    const outcomes = await Promise.allSettled([
      acl().revoke(f.first, f.workspaceId, f.bot.id, f.second),
      acl().revoke(f.second, f.workspaceId, f.bot.id, f.first),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason instanceof BotAccessError).toBe(true);
    expect((await snapshot(f.bot.id)).acl).toHaveLength(1);
    expect(
      (await snapshot(f.bot.id)).audits.filter((event) => event.event_type === 'bot.acl_revoked'),
    ).toHaveLength(1);
  });
  it('does not count an inactive retained owner or block workspace deprovisioning', async () => {
    const f = await fixture();
    await acl().grant(f.first, f.workspaceId, f.bot.id, { userId: f.target, role: 'owner' });
    await new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(runtime)).remove(
      f.workspaceOwner,
      f.workspaceId,
      f.target,
    );
    await expect(
      acl().changeRole(f.first, f.workspaceId, f.bot.id, f.first, { role: 'editor' }),
    ).rejects.toBeInstanceOf(LastBotOwnerError);
    expect(
      (await acl().list(f.first, f.workspaceId, f.bot.id)).find(
        (member) => member.user.id === f.target,
      )?.hasWorkspaceAccess,
    ).toBe(false);
    await acl().revoke(f.first, f.workspaceId, f.bot.id, f.target);
    await new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(runtime)).remove(
      f.workspaceOwner,
      f.workspaceId,
      f.first,
    );
    await expect(acl().list(f.first, f.workspaceId, f.bot.id)).rejects.toBeInstanceOf(
      BotAccessError,
    );
    await expect(acl().list(f.workspaceOwner, f.workspaceId, f.bot.id)).rejects.toBeInstanceOf(
      BotAccessError,
    );
    expect((await snapshot(f.bot.id)).acl).toHaveLength(1);
    expect((await snapshot(f.bot.id)).versions).toHaveLength(1);
  });
  it('rolls back grant, role, revoke and visibility changes when mandatory auditing fails', async () => {
    const f = await fixture(true),
      before = await snapshot(f.bot.id);
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(
        acl().grant(f.first, f.workspaceId, f.bot.id, { userId: f.target }),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        acl().changeRole(f.first, f.workspaceId, f.bot.id, f.second, { role: 'editor' }),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(acl().revoke(f.first, f.workspaceId, f.bot.id, f.second)).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        acl().changeVisibility(f.first, f.workspaceId, f.bot.id, { visibility: 'workspace' }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(await snapshot(f.bot.id)).toEqual(before);
  });
  it.each(['acl-revoke', 'workspace-remove'] as const)(
    'rejects a queued owner mutation after %s commits first',
    async (mutation) => {
      const f = await fixture(true),
        writer = observedPool(),
        waiter = observedPool();
      const blocker = await admin.connect(),
        pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const change =
          mutation === 'acl-revoke'
            ? acl(writer.pool).revoke(f.second, f.workspaceId, f.bot.id, f.first)
            : new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(writer.pool)).remove(
                f.workspaceOwner,
                f.workspaceId,
                f.first,
              );
        pending.push(change);
        void change.catch(() => undefined);
        const writerPid = await waitForBlocked(writer.name, blockerPid);
        const rejected = expect(
          acl(waiter.pool).changeVisibility(f.first, f.workspaceId, f.bot.id, {
            visibility: 'workspace',
          }),
        ).rejects.toBeInstanceOf(BotAccessError);
        pending.push(rejected);
        void rejected.catch(() => undefined);
        await waitForBlocked(waiter.name, writerPid);
        await blocker.query('COMMIT');
        await Promise.all(pending);
        const state = await snapshot(f.bot.id);
        expect(state.bot[0].visibility).toBe('private');
        expect(
          state.audits.filter((event) => event.event_type === 'bot.visibility_changed'),
        ).toHaveLength(0);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all([writer.pool.end(), waiter.pool.end()]);
      }
    },
    20000,
  );
  it.each(['acl-revoke', 'workspace-remove'] as const)(
    'holds an admitted owner change until commit before pending %s',
    async (mutation) => {
      const f = await fixture(true),
        writer = observedPool(),
        revoker = observedPool();
      const blocker = await admin.connect(),
        pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const change = acl(writer.pool).changeVisibility(f.first, f.workspaceId, f.bot.id, {
          visibility: 'workspace',
        });
        pending.push(change);
        void change.catch(() => undefined);
        const writerPid = await waitForBlocked(writer.name, blockerPid);
        const revoke =
          mutation === 'acl-revoke'
            ? acl(revoker.pool).revoke(f.second, f.workspaceId, f.bot.id, f.first)
            : new WorkspaceMemberService(
                new PostgresWorkspaceMemberRepository(revoker.pool),
              ).remove(f.workspaceOwner, f.workspaceId, f.first);
        pending.push(revoke);
        void revoke.catch(() => undefined);
        await waitForBlocked(revoker.name, writerPid);
        await blocker.query('COMMIT');
        await Promise.all(pending);
        expect((await snapshot(f.bot.id)).bot[0].visibility).toBe('workspace');
        expect(
          (await snapshot(f.bot.id)).audits.filter(
            (event) => event.event_type === 'bot.visibility_changed',
          ),
        ).toHaveLength(1);
        const connection = await runtime.connect();
        try {
          await connection.query('BEGIN');
          await expect(
            lockAuthorizedBot(
              connection,
              { actorUserId: f.first, workspaceId: f.workspaceId, botId: f.bot.id },
              'manageAcl',
            ),
          ).rejects.toBeInstanceOf(BotAccessError);
        } finally {
          await connection.query('ROLLBACK');
          connection.release();
        }
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all([writer.pool.end(), revoker.pool.end()]);
      }
    },
    20000,
  );
});

import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotService } from '../../src/bots/service.js';
import { appendQueuedRunState } from '../../src/conversations/append-event.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { ConversationService } from '../../src/conversations/service.js';
import { cleanupConversationStreams } from '../../src/conversations/stream-cleanup.js';
import { deliverConversationStream } from '../../src/conversations/stream-delivery.js';
import { ConversationStreamService } from '../../src/conversations/stream-service.js';
import {
  ConversationStreamError,
  encodeConversationStreamCursor,
  STREAM_LIMITS,
} from '../../src/conversations/stream-protocol.js';
import { reclaimConversationStream } from '../../src/conversations/stream-retention.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupBotService, type GroupBotGrant } from '../../src/group-bots/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import type { ModelAdapter } from '../../src/providers/model-events.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { TaskQueue, type TaskClaim } from '../../src/tasks/queue.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { barrier } from '../helpers/barrier.js';

// This suite rotates the fixed runtime role. Assign a disposable database and
// run it sequentially with any other suite sharing that PostgreSQL instance.
// Missing URL means discovery-only skips, never native verification.
const databaseUrl = process.env.TEST_CONVERSATION_STREAM_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'conversation delivery with deployed PostgreSQL privileges',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let runtime: pg.Pool;
    let runtimeUrl: string;
    const workspaces: string[] = [];

    beforeAll(async () => {
      await migrateDatabase(admin);
      const versions = (
        await admin.query<{ version: string }>('SELECT version FROM openbot_schema_migrations')
      ).rows.map((row) => row.version);
      expect(versions).toEqual(
        expect.arrayContaining([expect.stringMatching(/^0018_/u), '0019_conversation_delivery']),
      );
      const url = new URL(databaseUrl!);
      const password = `ci-stream-${randomBytes(24).toString('hex')}`;
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
      runtimeUrl = url.toString();
      runtime = new pg.Pool({ connectionString: runtimeUrl, statement_timeout: 15000 });
      const identity = (
        await runtime.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
          'SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0];
      expect(identity).toEqual({
        current_user: 'openbot_runtime',
        rolsuper: false,
        rolbypassrls: false,
      });
    }, 30000);
    afterEach(async () => {
      const ids = workspaces.splice(0);
      if (!ids.length) return;
      // Retained rows are never truncated. End unfinished fixture work legally so
      // a later real global queue claim cannot select an earlier test's run.
      const connection = await admin.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          `UPDATE task_runs SET status='failed',finished_at=clock_timestamp(),error_code='worker_interrupted'
           WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=ANY($1::uuid[]))
           AND status='running'
           AND EXISTS (
             SELECT 1 FROM task_run_leases l
             WHERE l.run_id=task_runs.id AND l.expires_at<=clock_timestamp()
           )`,
          [ids],
        );
        await connection.query(
          "UPDATE task_runs SET status='failed',finished_at=clock_timestamp(),error_code='worker_stopped' WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=ANY($1::uuid[])) AND status IN ('queued','running')",
          [ids],
        );
        await connection.query(
          "UPDATE tasks SET status='failed' WHERE workspace_id=ANY($1::uuid[]) AND status IN ('queued','running')",
          [ids],
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    });
    afterAll(async () => {
      await runtime?.end();
      await admin.end();
    });

    const conversations = (pool = runtime) =>
      new ConversationService(new PostgresConversationRepository(pool));
    async function session(userId: string) {
      const token = randomBytes(32).toString('base64url');
      const digest = createHash('sha256').update(token).digest('hex');
      await runtime.query(
        "INSERT INTO sessions(token_digest,user_id,created_at,expires_at) VALUES($1,$2,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')",
        [digest, userId],
      );
      return { token, digest };
    }
    async function fixture(group = false, duration = 300) {
      const ownerId = randomUUID(),
        actorId = randomUUID(),
        workspaceId = randomUUID();
      workspaces.push(workspaceId);
      for (const id of [ownerId, actorId])
        await runtime.query(
          'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
          [id, `${id}@example.com`, id === ownerId ? 'Stream owner' : 'Stream member'],
        );
      await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
        workspaceId,
        'Native streams',
      ]);
      for (const [id, role] of [
        [ownerId, 'owner'],
        [actorId, 'member'],
      ])
        await runtime.query(
          'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
          [workspaceId, id, role],
        );
      const secrets = new ProviderSecretBox(randomBytes(32).toString('base64'));
      const providers = new ProviderConnections(
        new PostgresProviderRepository(runtime),
        secrets,
        new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
        {
          run: async () => ({
            testedAt: new Date().toISOString(),
            text: { ok: true, code: 'passed', raw: 'OK' },
            action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
          }),
        },
      );
      // Only provider capability/transport is deterministic. SQL, role grants,
      // migrations, audit triggers, transactions and lock waits are native.
      const model = await providers.inWorkspace(workspaceId).save(ownerId, {
        protocol: 'openai-responses',
        name: 'Stream model',
        baseUrl: 'https://models.example/v1',
        modelId: 'stream-model',
        apiKey: 'native-stream-provider-secret',
        headers: {},
      });
      const bot = await new BotService(new PostgresBotRepository(runtime)).create(
        ownerId,
        workspaceId,
        {
          name: 'Stream Bot',
          roleDescription: 'Assistant',
          instructions: 'Private pinned stream instructions.',
          limits: { maxDurationSeconds: duration },
          modelBinding: {
            scope: { kind: 'workspace', id: workspaceId },
            connectionId: model.id,
            modelId: model.modelId,
          },
        },
      );
      let grant: GroupBotGrant | null = null;
      if (group) {
        const groups = new GroupService(new PostgresGroupRepository(runtime));
        const selected = await groups.create(ownerId, workspaceId, { name: 'Stream group' });
        await groups.addMember(ownerId, workspaceId, selected.id, {
          userId: actorId,
          role: 'member',
        });
        grant = await new GroupBotService(new PostgresGroupBotRepository(runtime)).invite(
          ownerId,
          workspaceId,
          selected.id,
          { botId: bot.id, idempotencyKey: 'stream-invite' },
        );
      } else
        await runtime.query(
          "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'user',NOW())",
          [bot.id, actorId],
        );
      const conversationId =
        grant?.conversationId ??
        (
          await conversations().open(actorId, workspaceId, {
            subject: { kind: 'direct-bot', id: bot.id },
          })
        ).id;
      const identity = await session(actorId);
      return { ownerId, actorId, workspaceId, conversationId, bot, grant, secrets, ...identity };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const scope = (f: Fixture) => ({
      workspaceId: f.workspaceId,
      conversationId: f.conversationId,
    });
    const cursor = (f: Fixture, after: number) => encodeConversationStreamCursor(scope(f), after);
    const append = (
      f: Fixture,
      pool = runtime,
      key = 'message',
      body = 'Current source message.',
    ) =>
      conversations(pool).append(f.actorId, f.workspaceId, f.conversationId, {
        idempotencyKey: key,
        body,
      });
    const submit = (f: Fixture, pool = runtime, key = 'task') =>
      new TaskService(pool).submit(f.actorId, f.workspaceId, f.conversationId, {
        idempotencyKey: key,
        body: 'Explain the stream evidence.',
        ...(f.grant ? { groupGrantId: f.grant.id } : {}),
      });
    async function claim() {
      const value = await new TaskQueue(runtime).claimNext();
      expect(value.claim).toBeDefined();
      return value.claim!;
    }
    const worker = (f: Fixture, generate: ModelAdapter['generate']) =>
      new TaskWorker(runtime, { secrets: f.secrets, createAdapter: () => ({ generate }) });
    async function snapshot(f: Fixture) {
      const row = (
        await admin.query<{
          tail: string;
          ledger: unknown[];
          tasks: unknown[];
          runs: unknown[];
          delivery: unknown[];
          state: unknown;
          progress: unknown[];
          receipts: unknown[];
          audits: unknown[];
        }>(
          `SELECT c.last_sequence::text AS tail,
      COALESCE((SELECT jsonb_agg(e ORDER BY e.sequence) FROM conversation_events e WHERE e.conversation_id=c.id),'[]') AS ledger,
      COALESCE((SELECT jsonb_agg(t ORDER BY t.id) FROM tasks t WHERE t.conversation_id=c.id),'[]') AS tasks,
      COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=c.id),'[]') AS runs,
      COALESCE((SELECT jsonb_agg(e ORDER BY e.sequence) FROM conversation_delivery_events e WHERE e.conversation_id=c.id),'[]') AS delivery,
      (SELECT to_jsonb(s) FROM conversation_delivery_state s WHERE s.conversation_id=c.id) AS state,
      COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.run_id) FROM task_run_streams s JOIN task_runs r ON r.id=s.run_id JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=c.id),'[]') AS progress,
      COALESCE((SELECT jsonb_agg(r ORDER BY r.sequence) FROM task_run_delivery_receipts r WHERE r.conversation_id=c.id),'[]') AS receipts,
      COALESCE((SELECT jsonb_agg(a ORDER BY a.id) FROM audit_events a WHERE a.metadata->>'conversationId'=c.id::text),'[]') AS audits
      FROM conversations c WHERE c.id=$1`,
          [f.conversationId],
        )
      ).rows[0];
      if (!row) throw new Error('Missing native fixture conversation');
      return row;
    }
    function observedPool() {
      const name = `stream-${randomUUID()}`;
      return {
        name,
        pool: new pg.Pool({
          connectionString: runtimeUrl,
          application_name: name,
          statement_timeout: 15000,
          max: 1,
        }),
      };
    }
    async function blocked(name: string, holderPid: number, query: RegExp) {
      await vi.waitFor(
        async () => {
          const rows = (
            await admin.query<{ query: string }>(
              `WITH RECURSIVE chain(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
        UNION SELECT unnest(pg_blocking_pids(chain.pid)) FROM chain
      ) SELECT query FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
        AND EXISTS(SELECT 1 FROM chain WHERE pid=$2)`,
              [name, holderPid],
            )
          ).rows;
          expect(rows).toHaveLength(1);
          expect(rows[0]?.query).toMatch(query);
        },
        { timeout: 5000, interval: 20 },
      );
    }
    async function afterWorkspaceWait<T>(
      f: Fixture,
      action: (pool: pg.Pool) => Promise<T>,
      change: (connection: pg.PoolClient) => Promise<unknown>,
    ) {
      const holder = await admin.connect(),
        observed = observedPool();
      let pending: Promise<PromiseSettledResult<T>[]> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid;
        pending = Promise.allSettled([action(observed.pool)]);
        await blocked(observed.name, pid, /FROM workspaces .*FOR UPDATE/u);
        await change(holder);
        await holder.query('COMMIT');
        return (await pending)[0]!;
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
        await observed.pool.end();
      }
    }
    async function transaction<T>(action: (connection: pg.PoolClient) => Promise<T>) {
      const connection = await runtime.connect();
      try {
        await connection.query('BEGIN');
        const value = await action(connection);
        await connection.query('COMMIT');
        return value;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
    async function sourceLocks(
      connection: pg.PoolClient,
      f: Fixture,
      taskId?: string,
      runId?: string,
    ) {
      await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
      if (f.grant)
        await connection.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE', [f.grant.groupId]);
      await connection.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [f.bot.id]);
      await connection.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
        f.conversationId,
      ]);
      if (taskId) await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
      if (runId) await connection.query('SELECT id FROM task_runs WHERE id=$1 FOR UPDATE', [runId]);
    }
    function frameData(frame: string): unknown {
      return JSON.parse(
        frame
          .split('\n')
          .find((line) => line.startsWith('data: '))!
          .slice(6),
      );
    }

    it('grants only the deployed delivery, floor, progress and retained-receipt privileges', async () => {
      const tables = [
        {
          table: 'conversation_delivery_events',
          allowed: ['SELECT', 'INSERT', 'DELETE'],
          columns: [],
        },
        {
          table: 'conversation_delivery_state',
          allowed: ['SELECT', 'INSERT'],
          columns: ['floor', 'retained_bytes', 'retained_count'],
        },
        { table: 'task_run_streams', allowed: ['SELECT', 'INSERT'], columns: ['delivered_bytes'] },
        { table: 'task_run_delivery_receipts', allowed: ['SELECT', 'INSERT'], columns: [] },
      ];
      for (const selected of tables) {
        for (const privilege of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          const result = await admin.query<{ allowed: boolean }>(
            'SELECT has_table_privilege($1,$2,$3) AS allowed',
            ['openbot_runtime', selected.table, privilege],
          );
          expect(result.rows[0]?.allowed).toBe(selected.allowed.includes(privilege));
        }
        const columns = (
          await admin.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND has_column_privilege('openbot_runtime',table_name,column_name,'UPDATE') ORDER BY column_name",
            [selected.table],
          )
        ).rows.map((row) => row.column_name);
        expect(columns).toEqual(selected.columns);
      }
    });

    it.each(['check', 'bootstrap', 'deliver'] as const)(
      'rechecks session revocation after %s waits for the real workspace lock',
      async (operation) => {
        const f = await fixture();
        await append(f);
        const enqueue = vi.fn();
        const result = await afterWorkspaceWait<unknown>(
          f,
          (pool) => {
            const service = new ConversationStreamService(pool);
            return operation === 'bootstrap'
              ? service.bootstrap(f.token, scope(f))
              : operation === 'check'
                ? service.check(f.token, scope(f), cursor(f, 0))
                : service.deliver(f.token, scope(f), cursor(f, 0), enqueue);
          },
          (connection) =>
            connection.query(
              'UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_digest=$1',
              [f.digest],
            ),
        );
        expect(result).toMatchObject({
          status: 'rejected',
          reason: new ConversationStreamError('authentication_required'),
        });
        expect(enqueue).not.toHaveBeenCalled();
      },
      15000,
    );

    it.each(['check', 'bootstrap', 'deliver'] as const)(
      'rechecks persisted session expiry after %s waits for the real workspace lock',
      async (operation) => {
        const f = await fixture();
        await append(f);
        const enqueue = vi.fn();
        const result = await afterWorkspaceWait<unknown>(
          f,
          (pool) => {
            const service = new ConversationStreamService(pool);
            return operation === 'bootstrap'
              ? service.bootstrap(f.token, scope(f))
              : operation === 'check'
                ? service.check(f.token, scope(f), cursor(f, 0))
                : service.deliver(f.token, scope(f), cursor(f, 0), enqueue);
          },
          (connection) =>
            connection.query(
              "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_digest=$1",
              [f.digest],
            ),
        );
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { code: 'authentication_required' },
        });
        expect(enqueue).not.toHaveBeenCalled();
      },
      15000,
    );

    it.each(['workspace', 'group', 'bot'] as const)(
      'denies fresh %s authority loss after waiting without enqueueing the selected message',
      async (kind) => {
        const f = await fixture(kind === 'group');
        await append(f);
        const enqueue = vi.fn();
        const result = await afterWorkspaceWait(
          f,
          (pool) =>
            new ConversationStreamService(pool).deliver(f.token, scope(f), cursor(f, 0), enqueue),
          (connection) =>
            connection.query(
              kind === 'workspace'
                ? 'DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2'
                : kind === 'group'
                  ? 'DELETE FROM group_memberships WHERE group_id=$1 AND user_id=$2'
                  : 'DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2',
              [
                kind === 'workspace'
                  ? f.workspaceId
                  : kind === 'group'
                    ? f.grant!.groupId
                    : f.bot.id,
                f.actorId,
              ],
            ),
        );
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { code: 'conversation_forbidden' },
        });
        expect(enqueue).not.toHaveBeenCalled();
      },
      15000,
    );

    it('keeps a direct conversation creator-private even for its workspace owner', async () => {
      const f = await fixture();
      await append(f);
      const owner = await session(f.ownerId);
      await expect(
        new ConversationStreamService(runtime).bootstrap(owner.token, scope(f)),
      ).rejects.toMatchObject({ code: 'conversation_forbidden' });
      const wrong = { ...scope(f), workspaceId: randomUUID() };
      await expect(
        new ConversationStreamService(runtime).check(f.token, wrong, cursor(f, 0)),
      ).rejects.toMatchObject({ code: 'conversation_forbidden' });
    });

    it('checks session expiry again after a real current-source read wait, before enqueueing', async () => {
      const f = await fixture();
      await append(f);
      await admin.query(
        "UPDATE sessions SET expires_at=clock_timestamp()+interval '5 seconds' WHERE token_digest=$1",
        [f.digest],
      );
      const holder = await admin.connect(),
        observed = observedPool(),
        enqueue = vi.fn();
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE conversation_events IN ACCESS EXCLUSIVE MODE');
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid;
        pending = Promise.allSettled([
          new ConversationStreamService(observed.pool).deliver(
            f.token,
            scope(f),
            cursor(f, 0),
            enqueue,
          ),
        ]);
        await blocked(observed.name, pid, /SELECT message_id FROM conversation_events/u);
        expect(
          (
            await admin.query<{ live: boolean }>(
              'SELECT clock_timestamp()<expires_at AS live FROM sessions WHERE token_digest=$1',
              [f.digest],
            )
          ).rows[0]?.live,
        ).toBe(true);
        await vi.waitFor(
          async () => {
            expect(
              (
                await admin.query<{ expired: boolean }>(
                  'SELECT clock_timestamp()>=expires_at AS expired FROM sessions WHERE token_digest=$1',
                  [f.digest],
                )
              ).rows[0]?.expired,
            ).toBe(true);
          },
          { timeout: 8000, interval: 25 },
        );
        await holder.query('COMMIT');
        expect((await pending)[0]).toMatchObject({
          status: 'rejected',
          reason: { code: 'authentication_required' },
        });
        expect(enqueue).not.toHaveBeenCalled();
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
        await observed.pool.end();
      }
    }, 20000);

    it.each(['session', 'workspace'] as const)(
      're-admits current %s authority after a blocked sink drains',
      async (kind) => {
        const f = await fixture();
        await append(f);
        await append(f, runtime, 'second', 'Must not be delivered after revocation.');
        const draining = barrier(),
          release = barrier(),
          stop = new AbortController();
        const frames: string[] = [];
        const close = vi.fn();
        const pending = deliverConversationStream(
          new ConversationStreamService(runtime),
          f.token,
          scope(f),
          cursor(f, 0),
          {
            queuedBytes: () => 0,
            write(frame) {
              frames.push(frame);
              return false;
            },
            async drain() {
              draining.resolve();
              await release.promise;
            },
            close,
          },
          stop.signal,
        );
        try {
          await draining.promise;
          expect(frames).toHaveLength(1);
          expect(frameData(frames[0]!)).toMatchObject({ sequence: 1, type: 'message.changed' });
          await admin.query(
            kind === 'session'
              ? 'UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_digest=$1'
              : 'DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
            kind === 'session' ? [f.digest] : [f.workspaceId, f.actorId],
          );
          release.resolve();
          await pending;
          expect(frames).toHaveLength(2);
          expect(frameData(frames[1]!)).toEqual({
            schemaVersion: 1,
            code: kind === 'session' ? 'authentication_required' : 'conversation_forbidden',
          });
          expect(frames[1]).not.toContain('id:');
          expect(close).toHaveBeenCalledOnce();
        } finally {
          release.resolve();
          stop.abort();
          await pending;
        }
      },
      15000,
    );

    it.each(['claim', 'finish'] as const)(
      'locks the denied execution source before Task/Run when %s must publish failure',
      async (stage) => {
        const f = await fixture(true),
          task = await submit(f),
          admitted = stage === 'finish' ? await claim() : undefined;
        await admin.query('DELETE FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
          f.grant!.groupId,
          f.actorId,
        ]);
        const holder = await admin.connect(),
          observed = observedPool();
        let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
            f.conversationId,
          ]);
          const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
            .rows[0]!.pid;
          pending = Promise.allSettled([
            stage === 'claim'
              ? new TaskQueue(observed.pool).claimNext()
              : new TaskQueue(observed.pool).finish(admitted!, {
                  body: 'Denied output.',
                  usage: null,
                }),
          ]);
          await blocked(observed.name, pid, /FROM conversations .*FOR UPDATE/u);
          const probe = await admin.connect();
          try {
            await probe.query('BEGIN');
            expect(
              (await probe.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE NOWAIT', [task.id]))
                .rows,
            ).toHaveLength(1);
            expect(
              (
                await probe.query('SELECT id FROM task_runs WHERE id=$1 FOR UPDATE NOWAIT', [
                  task.runs[0]!.id,
                ])
              ).rows,
            ).toHaveLength(1);
          } finally {
            await probe.query('ROLLBACK');
            probe.release();
          }
          await holder.query('COMMIT');
          expect((await pending)[0]?.status).toBe('fulfilled');
          const final = await snapshot(f);
          expect(final.runs).toEqual([
            expect.objectContaining({
              status: 'failed',
              error_code: 'execution_forbidden',
              output_event_id: null,
            }),
          ]);
          expect(final.delivery).toContainEqual(
            expect.objectContaining({ event_type: 'task.run.updated', run_status: 'failed' }),
          );
          expect(final.ledger).not.toContainEqual(
            expect.objectContaining({ event_type: 'bot.message.created' }),
          );
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
          await pending;
          await observed.pool.end();
        }
      },
      15000,
    );

    async function rejectInsert(
      f: Fixture,
      table: 'audit_events' | 'conversation_delivery_events',
      eventType: string,
      runStatus: string | null,
      action: () => Promise<unknown>,
    ) {
      const name = `reject_stream_${randomBytes(8).toString('hex')}`;
      const target =
        table === 'audit_events'
          ? "NEW.metadata->>'conversationId'=TG_ARGV[0]"
          : 'NEW.conversation_id::text=TG_ARGV[0]';
      const transition =
        table === 'conversation_delivery_events' && runStatus !== null
          ? ' AND NEW.run_status=TG_ARGV[2]'
          : '';
      await admin.query(
        `CREATE FUNCTION ${name}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF ${target} AND NEW.event_type=TG_ARGV[1]${transition} THEN RAISE EXCEPTION 'forced native stream insert failure'; END IF; RETURN NEW; END; $$`,
      );
      try {
        await admin.query(
          `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}('${f.conversationId}','${eventType}','${runStatus ?? ''}')`,
        );
        await expect(action()).rejects.toMatchObject({ code: 'P0001' });
      } finally {
        await admin.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
        await admin.query(`DROP FUNCTION ${name}()`);
      }
    }
    it.each([
      ['message', 'audit'],
      ['message', 'delivery'],
      ['submit', 'audit'],
      ['submit', 'delivery'],
      ['claim', 'audit'],
      ['claim', 'delivery'],
      ['complete', 'audit'],
      ['complete', 'delivery'],
      ['fail', 'audit'],
      ['fail', 'delivery'],
    ] as const)(
      'rolls back the whole %s transaction when its mandatory %s insert fails',
      async (stage, target) => {
        const f = await fixture();
        if (!['message', 'submit'].includes(stage)) await submit(f);
        const admitted = stage === 'complete' || stage === 'fail' ? await claim() : undefined;
        const before = await snapshot(f);
        const status =
          stage === 'submit'
            ? 'queued'
            : stage === 'claim'
              ? 'running'
              : stage === 'complete'
                ? 'completed'
                : 'failed';
        await rejectInsert(
          f,
          target === 'audit' ? 'audit_events' : 'conversation_delivery_events',
          target === 'audit'
            ? stage === 'message'
              ? 'conversation.message_created'
              : `task.${status}`
            : stage === 'message'
              ? 'message.changed'
              : 'task.run.updated',
          stage === 'message' ? null : status,
          () =>
            stage === 'message'
              ? append(f)
              : stage === 'submit'
                ? submit(f)
                : stage === 'claim'
                  ? new TaskQueue(runtime).claimNext()
                  : new TaskQueue(runtime).finish(
                      admitted!,
                      stage === 'complete'
                        ? {
                            body: 'Must roll back the output.',
                            usage: { inputTokens: 4, outputTokens: 3 },
                          }
                        : { error: 'provider_failed', usage: null },
                    ),
        );
        expect(await snapshot(f)).toEqual(before);
      },
    );

    it('rolls back first-delta allocation, stream progress and retention counters when its insert fails', async () => {
      const f = await fixture();
      await submit(f);
      const admitted = await claim();
      const before = await snapshot(f);
      await rejectInsert(f, 'conversation_delivery_events', 'assistant.delta', null, () =>
        new TaskQueue(runtime).publishDelta(admitted, 'Must not commit.'),
      );
      expect(await snapshot(f)).toEqual(before);
      await new TaskQueue(runtime).publishDelta(admitted, 'A real delta 🙂');
      expect((await snapshot(f)).progress).toEqual([
        { run_id: admitted.runId, delivered_bytes: Buffer.byteLength('A real delta 🙂') },
      ]);
    });

    async function expireAtPublication(f: Fixture, admitted: TaskClaim, stage: 'delta' | 'finish') {
      const name = `wait_stream_${randomBytes(8).toString('hex')}`;
      const key = randomBytes(4).readUInt32BE();
      const table = stage === 'delta' ? 'task_run_streams' : 'audit_events';
      const condition =
        stage === 'delta'
          ? 'NEW.run_id::text=TG_ARGV[0]'
          : "NEW.event_type='task.completed' AND NEW.metadata->>'conversationId'=TG_ARGV[0]";
      const target = stage === 'delta' ? admitted.runId : f.conversationId;
      await admin.query(
        `CREATE FUNCTION ${name}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint); END IF; RETURN NEW; END; $$`,
      );
      const holder = await admin.connect(),
        observed = observedPool();
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await admin.query(
          `CREATE TRIGGER ${name} BEFORE ${stage === 'delta' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}('${target}','${key}')`,
        );
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid;
        pending = Promise.allSettled([
          stage === 'delta'
            ? new TaskQueue(observed.pool).publishDelta(admitted, 'Expired while progress waited.')
            : new TaskQueue(observed.pool).finish(admitted, {
                body: 'Expired while the completion audit waited.',
                usage: null,
              }),
        ]);
        await blocked(
          observed.name,
          pid,
          stage === 'delta' ? /UPDATE task_run_streams/u : /INSERT INTO audit_events/u,
        );
        expect(
          (
            await admin.query<{ live: boolean }>(
              'SELECT clock_timestamp()<deadline_at AS live FROM task_runs WHERE id=$1',
              [admitted.runId],
            )
          ).rows[0]?.live,
        ).toBe(true);
        await vi.waitFor(
          async () => {
            expect(
              (
                await admin.query<{ expired: boolean }>(
                  'SELECT clock_timestamp()>=deadline_at AS expired FROM task_runs WHERE id=$1',
                  [admitted.runId],
                )
              ).rows[0]?.expired,
            ).toBe(true);
          },
          { timeout: 8000, interval: 25 },
        );
        await holder.query('COMMIT');
        return (await pending)[0]!;
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
        await observed.pool.end();
        await admin.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
        await admin.query(`DROP FUNCTION ${name}()`);
      }
    }
    it('rejects a delta whose real persisted deadline expires after its inserted row reaches the progress wait', async () => {
      const f = await fixture(false, 5);
      await submit(f);
      const admitted = await claim();
      const before = await snapshot(f);
      expect(await expireAtPublication(f, admitted, 'delta')).toMatchObject({
        status: 'rejected',
        reason: { code: 'execution_timeout' },
      });
      expect(await snapshot(f)).toEqual(before);
    }, 20000);

    it('rolls back attempted final publication after an audit wait expires, then fails the same run without output', async () => {
      const f = await fixture(false, 5);
      const task = await submit(f);
      const admitted = await claim();
      await new TaskQueue(runtime).publishDelta(admitted, 'Earlier authorized preview.');
      const before = await snapshot(f);
      expect((await expireAtPublication(f, admitted, 'finish')).status).toBe('fulfilled');
      const after = await snapshot(f);
      expect(after.ledger).toEqual(before.ledger);
      expect(after.progress).toEqual(before.progress);
      expect(Number(after.tail)).toBe(Number(before.tail) + 1);
      expect(after.tasks).toEqual([expect.objectContaining({ id: task.id, status: 'failed' })]);
      expect(after.runs).toEqual([
        expect.objectContaining({
          id: admitted.runId,
          status: 'failed',
          error_code: 'execution_timeout',
          output_event_id: null,
        }),
      ]);
      expect(after.delivery).toEqual([
        ...before.delivery,
        expect.objectContaining({ run_id: admitted.runId, run_status: 'failed' }),
      ]);
      expect(after.receipts).toEqual([
        ...before.receipts,
        expect.objectContaining({ run_id: admitted.runId, run_status: 'failed' }),
      ]);
      expect(after.audits).toHaveLength(before.audits.length + 1);
      expect(after.audits).toContainEqual(expect.objectContaining({ event_type: 'task.failed' }));
      expect(after.audits).not.toContainEqual(
        expect.objectContaining({ event_type: 'task.limit.warning' }),
      );
      expect(after.audits).not.toContainEqual(
        expect.objectContaining({ event_type: 'task.waiting_budget' }),
      );
      expect(JSON.stringify(after)).not.toContain('Expired while the completion audit waited.');
    }, 20000);

    it('rejects a conversation allocation that never appends a matching delivery', async () => {
      const f = await fixture();
      await append(f);
      const before = await snapshot(f);
      // A pre0019 writer only changed the conversation tail and source ledger.
      // The upgraded database must reject its missing delivery at COMMIT even
      // when that transaction never touches the delivery tables themselves.
      await expect(
        runtime.query('UPDATE conversations SET last_sequence=last_sequence+1 WHERE id=$1', [
          f.conversationId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(f)).toEqual(before);
      const receipt = await append(f, runtime, 'current-writer');
      const after = await snapshot(f);
      expect(Number(after.tail)).toBe(Number(before.tail) + 1);
      expect(after.delivery).toEqual([
        ...before.delivery,
        expect.objectContaining({
          sequence: receipt.sequence,
          ledger_event_id: receipt.eventId,
          event_type: 'message.changed',
        }),
      ]);
    });

    it('rejects delivery mutation and interior deletion even for the migration owner', async () => {
      const f = await fixture();
      await append(f);
      await append(f, runtime, 'second');
      const before = await snapshot(f);
      for (const pool of [runtime, admin]) {
        await expect(
          pool.query(
            'UPDATE conversation_delivery_events SET occurred_at=clock_timestamp() WHERE conversation_id=$1',
            [f.conversationId],
          ),
        ).rejects.toMatchObject({ code: pool === runtime ? '42501' : '55000' });
        await expect(pool.query('TRUNCATE conversation_delivery_events')).rejects.toMatchObject({
          code: pool === runtime ? '42501' : '55000',
        });
        await expect(
          pool.query(
            'DELETE FROM conversation_delivery_events WHERE conversation_id=$1 AND sequence=2',
            [f.conversationId],
          ),
        ).rejects.toMatchObject({ code: '55000' });
        await expect(
          pool.query('UPDATE conversation_delivery_state SET floor=999 WHERE conversation_id=$1', [
            f.conversationId,
          ]),
        ).rejects.toMatchObject({ code: '55000' });
      }
      await expect(
        transaction(async (connection) => {
          await connection.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
            f.conversationId,
          ]);
          await connection.query(
            'UPDATE conversation_delivery_state SET floor=1 WHERE conversation_id=$1',
            [f.conversationId],
          );
          await connection.query('SET CONSTRAINTS ALL IMMEDIATE');
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(f)).toEqual(before);
    });

    it('retains progress, floor and transition receipts and prevents invented offset advancement', async () => {
      const f = await fixture();
      await submit(f);
      const admitted = await claim();
      await new TaskQueue(runtime).publishDelta(admitted, 'Prefix');
      const before = await snapshot(f);
      for (const table of [
        'conversation_delivery_state',
        'task_run_streams',
        'task_run_delivery_receipts',
      ]) {
        for (const pool of [runtime, admin]) {
          await expect(pool.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
            code: pool === runtime ? '42501' : '55000',
          });
          await expect(pool.query(`TRUNCATE ${table}`)).rejects.toMatchObject({
            code: pool === runtime ? '42501' : '55000',
          });
        }
      }
      for (const pool of [runtime, admin]) {
        await expect(
          pool.query('UPDATE task_run_delivery_receipts SET sequence=sequence+1 WHERE run_id=$1', [
            admitted.runId,
          ]),
        ).rejects.toMatchObject({ code: pool === runtime ? '42501' : '55000' });
        await expect(
          pool.query(
            'UPDATE task_run_streams SET delivered_bytes=delivered_bytes+1 WHERE run_id=$1',
            [admitted.runId],
          ),
        ).rejects.toMatchObject({ code: '55000' });
      }
      expect(await snapshot(f)).toEqual(before);
    });

    it('atomically reclaims a contiguous prefix, preserves source rows and expires a blocked reader cursor', async () => {
      const f = await fixture();
      await append(f);
      await append(f, runtime, 'second');
      const before = await snapshot(f),
        holder = await runtime.connect(),
        observed = observedPool();
      const enqueue = vi.fn();
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
          f.conversationId,
        ]);
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid;
        pending = Promise.allSettled([
          new ConversationStreamService(observed.pool).deliver(
            f.token,
            scope(f),
            cursor(f, 0),
            enqueue,
          ),
        ]);
        await blocked(observed.name, pid, /FROM conversations .*FOR UPDATE/u);
        await reclaimConversationStream(
          holder,
          f.conversationId,
          new Date(Date.now() + STREAM_LIMITS.retentionMs + 1000),
        );
        await holder.query('COMMIT');
        expect((await pending)[0]).toMatchObject({
          status: 'rejected',
          reason: { code: 'cursor_expired' },
        });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
        await observed.pool.end();
      }
      const after = await snapshot(f);
      expect(after.delivery).toEqual([]);
      expect(after.ledger).toEqual(before.ledger);
      expect(after.audits).toEqual(before.audits);
      expect(after.state).toMatchObject({
        floor: Number(before.tail),
        retained_count: 0,
        retained_bytes: 0,
      });
      expect(enqueue).not.toHaveBeenCalled();
      const service = new ConversationStreamService(runtime);
      expect(await service.check(f.token, scope(f), cursor(f, Number(before.tail)))).toBe(
        cursor(f, Number(before.tail)),
      );
      await expect(
        service.check(f.token, scope(f), cursor(f, Number(before.tail) + 1)),
      ).rejects.toMatchObject({ code: 'invalid_stream_cursor' });
      await expect(
        runtime.query('UPDATE conversation_delivery_state SET floor=0 WHERE conversation_id=$1', [
          f.conversationId,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
    }, 15000);

    it('rolls back floor advancement when a mandatory prefix deletion fails', async () => {
      const f = await fixture();
      await append(f);
      const before = await snapshot(f);
      const name = `fail_stream_delete_${randomBytes(8).toString('hex')}`;
      await admin.query(
        `CREATE FUNCTION ${name}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF OLD.conversation_id::text=TG_ARGV[0] THEN RAISE EXCEPTION 'forced prefix delete failure'; END IF; RETURN OLD; END; $$`,
      );
      try {
        await admin.query(
          `CREATE TRIGGER ${name} BEFORE DELETE ON conversation_delivery_events FOR EACH ROW EXECUTE FUNCTION ${name}('${f.conversationId}')`,
        );
        await expect(
          transaction(async (connection) => {
            await connection.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
              f.conversationId,
            ]);
            await reclaimConversationStream(
              connection,
              f.conversationId,
              new Date(Date.now() + STREAM_LIMITS.retentionMs + 1000),
            );
          }),
        ).rejects.toMatchObject({ code: 'P0001' });
      } finally {
        await admin.query(`DROP TRIGGER IF EXISTS ${name} ON conversation_delivery_events`);
        await admin.query(`DROP FUNCTION ${name}()`);
      }
      expect(await snapshot(f)).toEqual(before);
    });

    it('retains transition and command receipts after cleanup so replays cannot allocate fresh events', async () => {
      const f = await fixture();
      const receipt = await append(f),
        task = await submit(f);
      const before = await snapshot(f);
      const later = new Date(Date.now() + STREAM_LIMITS.retentionMs + 1000);
      // Exercise the real bounded idle cleanup, not only its inner SQL helper.
      for (let page = 0; page < 100; page++) {
        await cleanupConversationStreams(runtime, later);
        if (!(await snapshot(f)).delivery.length) break;
        if (page === 99) throw new Error('Fixture was not reached by bounded cleanup');
      }
      const retained = await snapshot(f);
      expect(retained.delivery).toEqual([]);
      expect(retained.receipts).toEqual(before.receipts);
      await transaction(async (connection) => {
        await sourceLocks(connection, f, task.id, task.runs[0]!.id);
        await appendQueuedRunState(connection, task.runs[0]!.id, () => later);
      });
      expect(await append(f)).toEqual(receipt);
      expect((await submit(f)).id).toBe(task.id);
      expect(await snapshot(f)).toEqual(retained);
    });

    it('replays only the current source revision or tombstone without captured historical text', async () => {
      const f = await fixture(),
        original = await append(f, runtime, 'original', 'Superseded sensitive body.');
      const edited = await conversations().edit(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        original.messageId,
        { idempotencyKey: 'edit', expectedVersion: 1, body: 'Current permitted body.' },
      );
      const frames: string[] = [],
        service = new ConversationStreamService(runtime);
      await service.deliver(f.token, scope(f), cursor(f, 0), (frame) => frames.push(frame));
      expect(frameData(frames[0]!)).toMatchObject({
        sequence: original.sequence,
        data: {
          message: {
            messageId: original.messageId,
            versionEventId: edited.eventId,
            sequence: edited.sequence,
            deleted: false,
          },
        },
      });
      const deleted = await conversations().tombstone(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        original.messageId,
        { idempotencyKey: 'delete', expectedVersion: 2 },
      );
      await service.deliver(f.token, scope(f), cursor(f, 0), (frame) => frames.push(frame));
      expect(frameData(frames[1]!)).toMatchObject({
        data: { message: { versionEventId: deleted.eventId, deleted: true } },
      });
      expect((await service.bootstrap(f.token, scope(f))).messages).toEqual([
        expect.objectContaining({ messageId: original.messageId, deleted: true }),
      ]);
      expect(frames.join('')).not.toMatch(/Superseded sensitive body|Current permitted body/u);
    });

    it('omits an expired prefix among more than eight active executions and still delivers its later delta and final reference', async () => {
      const f = await fixture();
      const claims: TaskClaim[] = [];
      for (let n = 0; n < 9; n++) {
        await submit(f, runtime, `active-${n}`);
        const admitted = await claim();
        claims.push(admitted);
        await new TaskQueue(runtime).publishDelta(admitted, `run${n}:`);
      }
      const first = claims[0]!;
      const delta = (
        await runtime.query<{ sequence: string; occurred_at: Date }>(
          "SELECT sequence,occurred_at FROM conversation_delivery_events WHERE run_id=$1 AND event_type='assistant.delta'",
          [first.runId],
        )
      ).rows[0]!;
      await transaction(async (connection) => {
        await connection.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
          f.conversationId,
        ]);
        await reclaimConversationStream(
          connection,
          f.conversationId,
          new Date(delta.occurred_at.getTime() + STREAM_LIMITS.retentionMs),
        );
      });
      const service = new ConversationStreamService(runtime),
        initial = await service.bootstrap(f.token, scope(f));
      expect(initial.executions).toHaveLength(9);
      expect(initial.previewsTruncated).toBe(true);
      expect(initial.previews).toHaveLength(7);
      expect(initial.previews.some((preview) => preview.runId === first.runId)).toBe(false);
      expect(
        initial.previews.reduce((sum, preview) => sum + Buffer.byteLength(preview.text), 0),
      ).toBeLessThanOrEqual(STREAM_LIMITS.previewBytes);
      expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThanOrEqual(
        STREAM_LIMITS.bootstrapBytes,
      );
      await new TaskQueue(runtime).publishDelta(first, 'later');
      const frames: string[] = [];
      const delivered = await service.deliver(f.token, scope(f), initial.cursor, (frame) =>
        frames.push(frame),
      );
      expect(frameData(frames[0]!)).toMatchObject({
        type: 'assistant.delta',
        data: { runId: first.runId, startByte: 5, endByte: 10, text: 'later' },
      });
      await new TaskQueue(runtime).finish(first, {
        body: 'One current final answer.',
        usage: null,
      });
      await service.deliver(f.token, scope(f), delivered.cursor, (frame) => frames.push(frame));
      expect(frameData(frames[1]!)).toMatchObject({
        type: 'message.changed',
        data: { message: { runId: first.runId, deleted: false } },
      });
      expect(
        (
          await runtime.query('SELECT id FROM conversation_events WHERE bot_run_id=$1', [
            first.runId,
          ])
        ).rows,
      ).toHaveLength(1);
    }, 25000);

    it('commits the ordered callback delta before held provider completion and retains exactly one final output', async () => {
      const f = await fixture(),
        task = await submit(f),
        callback = barrier(),
        finish = barrier();
      const instance = worker(f, async (_input, _signal, observe) => {
        await observe?.({ type: 'text', text: 'First 🙂' });
        callback.resolve();
        await finish.promise;
        await observe?.({ type: 'text', text: ' then final.' });
        await observe?.({ type: 'complete', stopReason: 'stop' });
        return {
          raw: 'native-stream-provider-secret',
          events: [
            { type: 'text', text: 'First 🙂' },
            { type: 'text', text: ' then final.' },
            { type: 'complete', stopReason: 'stop' },
          ],
        };
      });
      const running = instance.runOnce();
      try {
        await Promise.race([
          callback.promise,
          running.then(() => {
            throw new Error('Worker ended before the callback barrier');
          }),
        ]);
        const early = await snapshot(f);
        expect(early.runs).toEqual([
          expect.objectContaining({ status: 'running', output_event_id: null }),
        ]);
        expect(early.delivery).toEqual([
          expect.objectContaining({ sequence: 1, event_type: 'message.changed' }),
          expect.objectContaining({ sequence: 2, run_status: 'queued' }),
          expect.objectContaining({ sequence: 3, run_status: 'running' }),
          expect.objectContaining({
            sequence: 4,
            event_type: 'assistant.delta',
            delta_text: 'First 🙂',
            start_byte: 0,
            end_byte: 10,
          }),
        ]);
        // The reader uses a separate runtime connection while the worker's
        // generation promise remains unresolved; no in-memory emitter is involved.
        const frames: string[] = [];
        await new ConversationStreamService(runtime).deliver(
          f.token,
          scope(f),
          cursor(f, 3),
          (frame) => frames.push(frame),
        );
        expect(frameData(frames[0]!)).toMatchObject({
          sequence: 4,
          type: 'assistant.delta',
          data: { text: 'First 🙂' },
        });
      } finally {
        finish.resolve();
        await running;
      }
      const rows = (
        await runtime.query<{
          sequence: string;
          event_type: string;
          delta_text: string | null;
          run_status: string | null;
        }>(
          'SELECT sequence,event_type,delta_text,run_status FROM conversation_delivery_events WHERE conversation_id=$1 ORDER BY sequence',
          [f.conversationId],
        )
      ).rows;
      expect(rows.map((row) => Number(row.sequence))).toEqual(rows.map((_row, index) => index + 1));
      expect(
        rows
          .filter((row) => row.event_type === 'assistant.delta')
          .map((row) => row.delta_text)
          .join(''),
      ).toBe('First 🙂 then final.');
      expect(rows.filter((row) => row.run_status).map((row) => row.run_status)).toEqual([
        'queued',
        'running',
        'completed',
      ]);
      expect(rows.at(-2)?.event_type).toBe('message.changed');
      const final = await new TaskService(runtime).get(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
      );
      expect(final.status).toBe('completed');
      expect(
        (
          await runtime.query(
            "SELECT id FROM conversation_events WHERE conversation_id=$1 AND event_type='bot.message.created'",
            [f.conversationId],
          )
        ).rows,
      ).toHaveLength(1);
      const beforeReplay = await snapshot(f);
      expect((await submit(f)).id).toBe(task.id);
      expect(
        await worker(f, async () => {
          throw new Error('No new generation');
        }).runOnce(),
      ).toBe(false);
      expect(await snapshot(f)).toEqual(beforeReplay);
      expect(JSON.stringify(rows)).not.toMatch(/native-stream-provider-secret|Private pinned/u);
    }, 20000);

    it.each(['reject', 'error-result'] as const)(
      'keeps %s after a complete callback failed without inventing a final ledger answer',
      async (mode) => {
        const f = await fixture();
        await submit(f);
        expect(
          await worker(f, async (_input, _signal, observe) => {
            await observe?.({ type: 'text', text: 'Preview must remain transient.' });
            await observe?.({ type: 'complete', stopReason: 'stop' });
            if (mode === 'reject') throw new Error('Private provider failure');
            return {
              events: [],
              raw: 'private',
              error: { code: 'private_error', category: 'retryable' },
            };
          }).runOnce(),
        ).toBe(true);
        const saved = await snapshot(f);
        expect(saved.runs).toEqual([
          expect.objectContaining({
            status: 'failed',
            error_code: 'provider_failed',
            output_event_id: null,
          }),
        ]);
        expect(saved.ledger).not.toContainEqual(
          expect.objectContaining({ event_type: 'bot.message.created' }),
        );
        expect(saved.delivery).toContainEqual(
          expect.objectContaining({
            event_type: 'assistant.delta',
            delta_text: 'Preview must remain transient.',
          }),
        );
        const bootstrap = await new ConversationStreamService(runtime).bootstrap(f.token, scope(f));
        expect(bootstrap.previews).toEqual([]);
        expect(bootstrap.executions[0]?.output).toBeNull();
      },
    );
  },
);

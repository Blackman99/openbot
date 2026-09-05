import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendBotVersion } from '../../src/bots/append-version.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotService } from '../../src/bots/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { ConversationAccessError, ConversationService } from '../../src/conversations/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { closeGroupBotGrant } from '../../src/group-bots/postgres-closures.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupBotService, type GroupBotGrant } from '../../src/group-bots/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import type {
  ModelAdapter,
  ModelInput,
  ModelResponse,
  ProviderProtocol,
} from '../../src/providers/model-events.js';
import { authorizeProviderScope } from '../../src/providers/postgres-provider-scope.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { personalAccess } from '../../src/providers/scope.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderError, ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import { TaskAccessError, TaskConflictError, TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';

// This provisioner rotates the fixed runtime role. Use the isolated task job's
// disposable database, never another native suite's PostgreSQL service.
const databaseUrl = process.env.TEST_TASK_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'durable Tasks with deployed PostgreSQL privileges',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let runtime: pg.Pool;
    const workspaces: string[] = [];

    beforeAll(async () => {
      // Exercise the ordered, integrated 0016 + 0017 migration and every PG guard.
      // There is deliberately no fixture-only schema or migration placeholder.
      await migrateDatabase(admin);
      const versions = (await admin.query('SELECT version FROM openbot_schema_migrations')).rows;
      expect(versions.map((row) => row.version)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^0016_/u),
          expect.stringMatching(/^0017_/u),
        ]),
      );
      const url = new URL(databaseUrl!);
      const password = `ci-task-${randomBytes(24).toString('hex')}`;
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
      // Retained tables cannot be truncated. End unconsumed fixture work through
      // legal transitions so the global queue cannot select a previous case.
      const ids = workspaces.splice(0);
      if (!ids.length) return;
      await admin.query(
        `UPDATE task_runs SET status='failed',finished_at=NOW(),error_code='worker_stopped'
       WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=ANY($1::uuid[]))
       AND status IN ('queued','running')`,
        [ids],
      );
      await admin.query(
        "UPDATE tasks SET status='failed' WHERE workspace_id=ANY($1::uuid[]) AND status IN ('queued','running')",
        [ids],
      );
    });
    afterAll(async () => {
      await runtime?.end();
      await admin.end();
    });

    const conversations = (pool = runtime) =>
      new ConversationService(new PostgresConversationRepository(pool));
    const grants = () => new GroupBotService(new PostgresGroupBotRepository(runtime));
    async function fixture(scope: 'personal' | 'workspace' = 'personal', inGroup = false) {
      const ownerId = randomUUID(),
        memberId = randomUUID(),
        workspaceId = randomUUID();
      workspaces.push(workspaceId);
      for (const id of [ownerId, memberId])
        await runtime.query(
          'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
          [id, `${id}@example.com`, id === ownerId ? 'Task owner' : 'Triggering member'],
        );
      await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
        workspaceId,
        'Tasks',
      ]);
      for (const [id, role] of [
        [ownerId, 'owner'],
        [memberId, 'member'],
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
      // Only provider capability/transport is a deterministic fixture. SQL,
      // migration guards, role grants, transactions and lock waits are native.
      const model = await (
        scope === 'workspace' ? providers.inWorkspace(workspaceId) : providers
      ).save(ownerId, {
        protocol: 'openai-responses',
        name: 'Task model',
        baseUrl: 'https://models.example/v1',
        modelId: 'task-model',
        apiKey: 'native-task-fixture',
        headers: {},
      });
      const bot = await new BotService(new PostgresBotRepository(runtime)).create(
        ownerId,
        workspaceId,
        {
          name: 'Evidence Bot',
          roleDescription: 'Assistant',
          instructions: 'Use the pinned instructions.',
          modelBinding: {
            scope: { kind: scope, id: scope === 'personal' ? ownerId : workspaceId },
            connectionId: model.id,
            modelId: model.modelId,
          },
        },
      );
      let grant: GroupBotGrant | null = null;
      if (inGroup) {
        const groups = new GroupService(new PostgresGroupRepository(runtime));
        const group = await groups.create(ownerId, workspaceId, { name: 'Execution group' });
        await groups.addMember(ownerId, workspaceId, group.id, {
          userId: memberId,
          role: 'member',
        });
        const earlier = await conversations().open(ownerId, workspaceId, {
          subject: { kind: 'group', id: group.id },
        });
        await conversations().append(ownerId, workspaceId, earlier.id, {
          idempotencyKey: 'before-bot-invitation',
          body: 'Earlier group history must stay outside the future-only grant.',
        });
        grant = await grants().invite(ownerId, workspaceId, group.id, {
          botId: bot.id,
          idempotencyKey: 'invite',
        });
      }
      const conversationId =
        grant?.conversationId ??
        (
          await conversations().open(ownerId, workspaceId, {
            subject: { kind: 'direct-bot', id: bot.id },
          })
        ).id;
      return {
        ownerId,
        memberId,
        actorId: inGroup ? memberId : ownerId,
        workspaceId,
        bot,
        model,
        providers,
        secrets,
        conversationId,
        grant,
      };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const submit = (f: Fixture, pool = runtime, key = 'task', body = 'Explain the evidence.') =>
      new TaskService(pool).submit(f.actorId, f.workspaceId, f.conversationId, {
        idempotencyKey: key,
        body,
        ...(f.grant ? { groupGrantId: f.grant.id } : {}),
      });
    const read = (f: Fixture, id: string, pool = runtime, actor = f.actorId) =>
      new TaskService(pool).get(actor, f.workspaceId, f.conversationId, id);
    async function snapshot(f: Fixture) {
      return (
        await admin.query(
          `SELECT
       (SELECT to_jsonb(c) FROM conversations c WHERE id=$1) AS conversation,
       (SELECT jsonb_agg(e ORDER BY e.sequence) FROM conversation_events e WHERE conversation_id=$1) AS events,
       (SELECT jsonb_agg(t ORDER BY t.id) FROM tasks t WHERE conversation_id=$1) AS tasks,
       (SELECT jsonb_agg(r ORDER BY r.id) FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=$1) AS runs,
       (SELECT jsonb_agg(a ORDER BY a.id) FROM audit_events a WHERE metadata->>'conversationId'=$1::text) AS audits`,
          [f.conversationId],
        )
      ).rows[0];
    }
    function observedPool() {
      const name = `task-${randomUUID()}`;
      return {
        name,
        pool: new pg.Pool({
          connectionString: runtime.options.connectionString,
          application_name: name,
          statement_timeout: 15000,
          max: 1,
        }),
      };
    }
    async function blocked(name: string, blockerPid: number) {
      await vi.waitFor(
        async () => {
          // PostgreSQL may queue a waiter behind another waiter. Traverse actual
          // blockers; do not require every contender to directly block on the holder.
          const found = await admin.query(
            `WITH RECURSIVE chain(pid) AS (
           SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
           UNION SELECT unnest(pg_blocking_pids(chain.pid)) FROM chain
         ) SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
           AND EXISTS (SELECT 1 FROM chain WHERE pid=$2)`,
            [name, blockerPid],
          );
          expect(found.rows).toHaveLength(1);
        },
        { timeout: 5000, interval: 20 },
      );
    }
    async function duringWait<T>(
      f: Fixture,
      action: (pool: pg.Pool) => Promise<T>,
      change: (connection: pg.PoolClient) => Promise<unknown>,
      atModel = false,
    ) {
      const holder = await runtime.connect(),
        observed = observedPool();
      let pending: Promise<PromiseSettledResult<T>[]> | undefined;
      try {
        await holder.query('BEGIN');
        if (atModel) await authorizeProviderScope(holder, personalAccess(f.ownerId), 'manage');
        else
          await holder.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
        const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = Promise.allSettled([action(observed.pool)]);
        await blocked(observed.name, pid);
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
    async function rejectingAudit(
      type: 'task.queued' | 'task.running' | 'task.completed' | 'task.failed',
      action: () => Promise<unknown>,
    ) {
      const name = `fail_task_audit_${randomBytes(8).toString('hex')}`;
      await admin.query(
        `CREATE FUNCTION ${name}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type=TG_ARGV[0] THEN RAISE EXCEPTION 'forced final task audit failure'; END IF; RETURN NEW; END; $$`,
      );
      try {
        await admin.query(
          `CREATE TRIGGER ${name} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${name}('${type}')`,
        );
        await expect(action()).rejects.toMatchObject({ code: 'P0001' });
      } finally {
        await admin.query(`DROP TRIGGER IF EXISTS ${name} ON audit_events`);
        await admin.query(`DROP FUNCTION ${name}()`);
      }
    }
    async function claim() {
      const selected = await new TaskQueue(runtime).claimNext();
      expect(selected.claim).toBeDefined();
      return selected.claim!;
    }
    async function contenders<T>(f: Fixture, action: (pool: pg.Pool) => Promise<T>) {
      const holder = await runtime.connect(),
        observers = [observedPool(), observedPool()];
      const actions: Promise<T>[] = [];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
        const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        actions.push(...observers.map(({ pool }) => action(pool)));
        const settled = Promise.allSettled(actions);
        for (const observer of observers) await blocked(observer.name, pid);
        await holder.query('COMMIT');
        expect((await settled).every((result) => result.status === 'fulfilled')).toBe(true);
        return await Promise.all(actions);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await Promise.allSettled(actions);
        await Promise.all(observers.map(({ pool }) => pool.end()));
      }
    }
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const worker = (f: Fixture, generate: ModelAdapter['generate']) =>
      new TaskWorker(runtime, {
        secrets: f.secrets,
        createAdapter: () => ({ generate }),
      });

    it('grants only lifecycle columns and guards retained identities even against the migration owner', async () => {
      const f = await fixture(),
        task = await submit(f),
        other = await fixture();
      for (const table of ['tasks', 'task_runs']) {
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
          ).toBe(['SELECT', 'INSERT'].includes(privilege));
        const columns = (
          await admin.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND has_column_privilege('openbot_runtime',table_name,column_name,'UPDATE') ORDER BY column_name",
            [table],
          )
        ).rows.map((row) => row.column_name);
        expect(columns).toEqual(
          table === 'tasks'
            ? ['status']
            : [
                'status',
                'started_at',
                'finished_at',
                'claim_token',
                'deadline_at',
                'provider_scope_kind',
                'provider_scope_id',
                'connection_id',
                'connection_revision',
                'protocol',
                'model_id',
                'input_tokens',
                'output_tokens',
                'error_code',
                'output_event_id',
              ].sort(),
        );
        await expect(runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
          code: '42501',
        });
        await expect(admin.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '55000' });
        await expect(admin.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({
          code: '55000',
        });
      }
      for (const fn of ['protect_task()', 'protect_task_run()', 'protect_bot_output()'])
        expect(
          (
            await admin.query(
              "SELECT has_function_privilege('openbot_runtime',$1,'EXECUTE') AS allowed",
              [fn],
            )
          ).rows[0].allowed,
        ).toBe(false);
      for (const pool of [runtime, admin]) {
        await expect(
          pool.query('UPDATE tasks SET execution_user_id=$2 WHERE id=$1', [task.id, f.memberId]),
        ).rejects.toMatchObject({ code: pool === runtime ? '42501' : '55000' });
        await expect(
          pool.query('UPDATE task_runs SET attempt=2 WHERE task_id=$1', [task.id]),
        ).rejects.toMatchObject({ code: pool === runtime ? '42501' : '55000' });
        await expect(
          pool.query("UPDATE tasks SET status='running' WHERE id=$1", [task.id]),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          pool.query(
            "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,2,'queued',NOW())",
            [randomUUID(), task.id],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      await expect(
        admin.query(
          `INSERT INTO tasks(id,workspace_id,conversation_id,bot_id,bot_version_id,group_grant_id,execution_user_id,trigger_event_id,command_hash,status,created_at)
       SELECT $2,$3,conversation_id,bot_id,bot_version_id,group_grant_id,execution_user_id,trigger_event_id,command_hash,status,created_at FROM tasks WHERE id=$1`,
          [task.id, randomUUID(), other.workspaceId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        runtime.query(
          `UPDATE task_runs SET status='running',started_at=NOW(),claim_token=$2,deadline_at=NOW()+INTERVAL '5 minutes',provider_scope_kind='personal',provider_scope_id=$3,connection_id=$4,connection_revision=0,protocol='openai-responses',model_id='wrong-model' WHERE task_id=$1`,
          [task.id, randomUUID(), f.ownerId, f.model.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect((await read(f, task.id)).status).toBe('queued');
    });

    it('serializes duplicate submissions and reconstructs one Task, trigger and first Run without crossing scope', async () => {
      const f = await fixture(),
        holder = await runtime.connect(),
        a = observedPool(),
        b = observedPool();
      const actions: Promise<Awaited<ReturnType<typeof submit>>>[] = [];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
        const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        actions.push(submit(f, a.pool), submit(f, b.pool));
        const settled = Promise.allSettled(actions);
        await blocked(a.name, pid);
        await blocked(b.name, pid);
        await holder.query('COMMIT');
        expect((await settled).every((result) => result.status === 'fulfilled')).toBe(true);
        const [first, second] = await Promise.all(actions);
        expect(second).toEqual(first);
        await expect(submit(f, runtime, 'task', 'Different command.')).rejects.toBeInstanceOf(
          TaskConflictError,
        );
        const saved = await snapshot(f);
        expect(saved.events).toHaveLength(1);
        expect(saved.tasks).toHaveLength(1);
        expect(saved.runs).toHaveLength(1);
        expect(saved.audits).toHaveLength(2);
        expect(saved.conversation.last_sequence).toBe(1);
        const rebuilt = observedPool();
        try {
          expect(await read(f, first!.id, rebuilt.pool)).toEqual(first);
          expect(
            (
              await new TaskService(rebuilt.pool).list(
                f.actorId,
                f.workspaceId,
                f.conversationId,
                {},
              )
            ).tasks,
          ).toEqual([first]);
          await expect(read(f, first!.id, rebuilt.pool, f.memberId)).rejects.toBeInstanceOf(
            TaskAccessError,
          );
          const foreign = await fixture();
          await expect(
            new TaskService(rebuilt.pool).get(
              f.actorId,
              foreign.workspaceId,
              f.conversationId,
              first!.id,
            ),
          ).rejects.toBeInstanceOf(TaskAccessError);
          await expect(read(foreign, first!.id, rebuilt.pool)).rejects.toBeInstanceOf(
            TaskAccessError,
          );
        } finally {
          await rebuilt.pool.end();
        }
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await Promise.allSettled(actions);
        await Promise.all([a.pool.end(), b.pool.end()]);
      }
    }, 20000);

    it.each(['queued', 'running', 'completed', 'failed'] as const)(
      'rolls back the entire %s transaction when its final mandatory audit fails',
      async (stage) => {
        const f = await fixture();
        const task = stage === 'queued' ? undefined : await submit(f);
        const selected = stage === 'completed' || stage === 'failed' ? await claim() : undefined;
        const action = () =>
          stage === 'queued'
            ? submit(f)
            : stage === 'running'
              ? new TaskQueue(runtime).claimNext()
              : new TaskQueue(runtime).finish(
                  selected!,
                  stage === 'failed'
                    ? { error: 'provider_failed', usage: { inputTokens: 4, outputTokens: 2 } }
                    : {
                        body: 'Committed only with audit.',
                        usage: { inputTokens: 4, outputTokens: 2 },
                      },
                );
        const before = await snapshot(f);
        await rejectingAudit(`task.${stage}`, action);
        expect(await snapshot(f)).toEqual(before);
        await action();
        const after = await snapshot(f);
        expect(after.tasks).toHaveLength(1);
        expect(after.runs).toHaveLength(1);
        expect(after.tasks[0].status).toBe(stage);
        expect(after.runs[0].status).toBe(stage);
        expect(after.events).toHaveLength(stage === 'completed' ? 2 : 1);
        if (task) expect(after.tasks[0].id).toBe(task.id);
      },
    );

    it('persists a group member claim before I/O and publishes only after the whole successful provider promise', async () => {
      const f = await fixture('workspace', true),
        task = await submit(f),
        workerClient = observedPool(),
        gate = deferred();
      const calls: { protocol: ProviderProtocol; input: ModelInput }[] = [];
      const events: ModelResponse['events'] = [
        { type: 'text', text: 'Verified answer.' },
        { type: 'usage', inputTokens: 5, outputTokens: 2 },
        { type: 'usage', inputTokens: 5, outputTokens: 3 },
        { type: 'complete', stopReason: 'stop' },
      ];
      const running = new TaskWorker(workerClient.pool, {
        secrets: f.secrets,
        createAdapter: (protocol) => ({
          generate: async (input, _signal, observe) => {
            for (const event of events) await observe?.(event);
            calls.push({ protocol, input });
            await gate.promise;
            return { events, raw: 'private native transport fixture' };
          },
        }),
      }).runOnce();
      const settled = Promise.allSettled([running]);
      try {
        await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000, interval: 20 });
        expect(calls[0]).toMatchObject({
          protocol: 'openai-responses',
          input: {
            modelId: 'task-model',
            apiKey: 'native-task-fixture',
            messages: [
              { role: 'system', content: 'Use the pinned instructions.' },
              { role: 'user', content: 'Explain the evidence.' },
            ],
          },
        });
        expect(
          (
            await runtime.query('SELECT user_id FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
              f.bot.id,
              f.actorId,
            ])
          ).rows,
        ).toHaveLength(0);
        expect(await read(f, task.id)).toMatchObject({
          status: 'running',
          executionUser: { id: f.memberId },
          groupGrantId: f.grant!.id,
          runs: [
            {
              status: 'running',
              provider: { protocol: 'openai-responses', modelId: 'task-model' },
              output: null,
              usage: null,
            },
          ],
        });
        expect(
          (await snapshot(f)).events.filter(
            (event: { event_type: string }) => event.event_type === 'bot.message.created',
          ),
        ).toHaveLength(0);
        const internal = (
          await admin.query(
            'SELECT claim_token,deadline_at,provider_scope_id,connection_id,connection_revision FROM task_runs WHERE task_id=$1',
            [task.id],
          )
        ).rows[0];
        expect(internal).toMatchObject({
          claim_token: expect.any(String),
          deadline_at: expect.any(Date),
          provider_scope_id: f.workspaceId,
          connection_id: f.model.id,
          connection_revision: 0,
        });
        gate.resolve();
        expect(await running).toBe(true);
      } finally {
        gate.resolve();
        await settled;
        await workerClient.pool.end();
      }
      const rebuilt = observedPool();
      try {
        const final = await read(f, task.id, rebuilt.pool);
        expect(final).toMatchObject({
          status: 'completed',
          bot: { versionId: task.bot.versionId },
          runs: [
            {
              attempt: 1,
              status: 'completed',
              usage: { inputTokens: 5, outputTokens: 3 },
              error: null,
              output: { sequence: 4 },
            },
          ],
        });
        expect(
          (await new TaskService(rebuilt.pool).list(f.actorId, f.workspaceId, f.conversationId, {}))
            .tasks,
        ).toEqual([final]);
        expect(await new TaskQueue(rebuilt.pool).claimNext()).toEqual({ handled: false });
        const located = await conversations(rebuilt.pool).get(
          f.actorId,
          f.workspaceId,
          f.conversationId,
          { messageId: final.runs[0]!.output!.messageId, limit: '1' },
        );
        expect(located.messages).toHaveLength(1);
        expect(located.messages[0]?.id).toBe(final.runs[0]!.output!.messageId);
        const page = await conversations(rebuilt.pool).get(
          f.actorId,
          f.workspaceId,
          f.conversationId,
          {},
        );
        expect(
          page.messages.find((message) => message.id === final.runs[0]!.output!.messageId),
        ).toMatchObject({
          body: 'Verified answer.',
          author: { kind: 'bot', id: f.bot.id, versionId: task.bot.versionId, versionNumber: 1 },
          canEdit: false,
          canDelete: false,
          canAudit: false,
        });
        const audits = (await snapshot(f)).audits.filter(
          (audit: { event_type: string }) =>
            audit.event_type.startsWith('task.') ||
            audit.event_type === 'conversation.bot_message_created',
        );
        expect(audits.map((audit: { actor_user_id: string }) => audit.actor_user_id)).toEqual(
          Array(4).fill(f.memberId),
        );
        expect(JSON.stringify([final, audits])).not.toMatch(
          /native-task-fixture|models\.example|pinned instructions|sealed|private native transport/u,
        );
      } finally {
        await rebuilt.pool.end();
      }
    }, 20000);

    it.each(['rejects', 'returns-error'] as const)(
      'records failure without Bot output when the provider %s after a complete callback',
      async (failure) => {
        const f = await fixture(),
          task = await submit(f);
        expect(
          await worker(f, async (_input, _signal, observe) => {
            await observe?.({ type: 'text', text: 'Uncommitted partial answer.' });
            await observe?.({ type: 'usage', inputTokens: 4, outputTokens: 2 });
            await observe?.({ type: 'complete', stopReason: 'stop' });
            if (failure === 'rejects')
              throw new Error('private provider failure native-task-fixture');
            return {
              events: [],
              raw: 'private provider failure',
              error: { code: 'private_error', category: 'retryable' },
            };
          }).runOnce(),
        ).toBe(true);
        const final = await read(f, task.id),
          saved = await snapshot(f);
        expect(final).toMatchObject({
          status: 'failed',
          runs: [
            { error: 'provider_failed', output: null, usage: { inputTokens: 4, outputTokens: 2 } },
          ],
        });
        expect(saved.events).toHaveLength(1);
        expect(saved.events[0]).toMatchObject({
          event_type: 'message.created',
          body: 'Explain the evidence.',
        });
        expect(
          saved.audits.filter(
            (audit: { event_type: string }) => audit.event_type === 'task.failed',
          ),
        ).toHaveLength(1);
        expect(JSON.stringify([final, saved.audits])).not.toMatch(
          /private provider|native-task-fixture|Uncommitted partial/u,
        );
      },
    );

    it('observes competing claims and completions, fences stale tokens and keeps terminal outputs immutable', async () => {
      const f = await fixture(),
        task = await submit(f);
      const selected = await contenders(f, (pool) => new TaskQueue(pool).claimNext());
      const claims = selected.flatMap((result) => (result.claim ? [result.claim] : []));
      expect(claims).toHaveLength(1);
      expect(selected.filter((result) => !result.handled)).toHaveLength(1);
      const admitted = claims[0]!;
      expect(admitted.taskId).toBe(task.id);
      const before = await snapshot(f);
      expect(
        await new TaskQueue(runtime).finish(
          { ...admitted, claimToken: randomUUID() },
          { body: 'Stale output.', usage: null },
        ),
      ).toBe(false);
      expect(await snapshot(f)).toEqual(before);
      for (const pool of [runtime, admin])
        await expect(
          pool.query(
            "UPDATE task_runs SET status='failed',finished_at=NOW(),error_code='provider_failed',connection_revision=connection_revision+1 WHERE id=$1",
            [admitted.runId],
          ),
        ).rejects.toMatchObject({ code: '55000' });
      // A raw Bot event must retain the exact running Task's author/version data.
      await expect(
        runtime.query(
          `INSERT INTO conversation_events(id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,idempotency_key,command_hash,event_data,bot_run_id)
       VALUES($1,$2,2,$3,1,'bot.message.created',$4,NOW(),'Forged Bot identity.',$5,$6,'{}'::jsonb,$7)`,
          [
            randomUUID(),
            f.conversationId,
            randomUUID(),
            f.actorId,
            randomUUID(),
            'a'.repeat(64),
            admitted.runId,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const completed = await contenders(f, (pool) =>
        new TaskQueue(pool).finish(admitted, {
          body: 'One final answer.',
          usage: { inputTokens: 6, outputTokens: 2 },
        }),
      );
      expect(completed.sort()).toEqual([false, true]);
      const final = await read(f, task.id),
        output = final.runs[0]!.output!;
      expect((await snapshot(f)).events).toHaveLength(2);
      expect(final.status).toBe('completed');
      for (const pool of [runtime, admin]) {
        await expect(
          pool.query("UPDATE tasks SET status='queued' WHERE id=$1", [task.id]),
        ).rejects.toMatchObject({ code: '55000' });
        await expect(
          pool.query('UPDATE task_runs SET output_tokens=99 WHERE id=$1', [admitted.runId]),
        ).rejects.toMatchObject({ code: '55000' });
        await expect(
          pool.query('UPDATE conversation_events SET body=$2 WHERE id=$1', [
            output.eventId,
            'Changed.',
          ]),
        ).rejects.toMatchObject({ code: pool === runtime ? '42501' : '55000' });
        await expect(
          pool.query(
            `INSERT INTO conversation_events(id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,idempotency_key,command_hash,event_data)
         VALUES($1,$2,3,$3,2,'message.edited',$4,NOW(),'Human forgery.',$5,$6,'{}'::jsonb)`,
            [
              randomUUID(),
              f.conversationId,
              output.messageId,
              f.actorId,
              randomUUID(),
              'b'.repeat(64),
            ],
          ),
        ).rejects.toMatchObject({ code: '55000' });
      }
      await expect(
        conversations().edit(f.actorId, f.workspaceId, f.conversationId, output.messageId, {
          idempotencyKey: 'edit-output',
          expectedVersion: 1,
          body: 'Changed.',
        }),
      ).rejects.toBeInstanceOf(ConversationAccessError);
      await expect(
        conversations().tombstone(f.actorId, f.workspaceId, f.conversationId, output.messageId, {
          idempotencyKey: 'delete-output',
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ConversationAccessError);
      expect(
        await new TaskQueue(runtime).finish(admitted, { error: 'provider_failed', usage: null }),
      ).toBe(false);
      expect(await read(f, task.id)).toEqual(final);
    }, 25000);

    it('retains a failed Run and cannot reopen it or manufacture a terminal output', async () => {
      const f = await fixture(),
        task = await submit(f),
        admitted = await claim();
      await new TaskQueue(runtime).finish(admitted, { error: 'provider_failed', usage: null });
      const before = await snapshot(f);
      for (const pool of [runtime, admin]) {
        await expect(
          pool.query("UPDATE tasks SET status='queued' WHERE id=$1", [task.id]),
        ).rejects.toMatchObject({ code: '55000' });
        await expect(
          pool.query(
            "UPDATE task_runs SET status='running',error_code=NULL,finished_at=NULL WHERE id=$1",
            [admitted.runId],
          ),
        ).rejects.toMatchObject({ code: '55000' });
      }
      expect(
        await new TaskQueue(runtime).finish(admitted, {
          body: 'Late fabricated success.',
          usage: null,
        }),
      ).toBe(false);
      expect(await snapshot(f)).toEqual(before);
    });

    it.each(['workspace', 'bot'] as const)(
      'rechecks current %s permission before replay after a submission waits',
      async (scope) => {
        const f = await fixture();
        await submit(f);
        const before = await snapshot(f);
        const result = await duringWait(
          f,
          (pool) => submit(f, pool),
          (connection) =>
            connection.query(
              scope === 'workspace'
                ? 'DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2'
                : 'DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2',
              [scope === 'workspace' ? f.workspaceId : f.bot.id, f.actorId],
            ),
        );
        expect(result).toMatchObject({ status: 'rejected', reason: expect.any(TaskAccessError) });
        await expect(submit(f, runtime, 'new-command')).rejects.toBeInstanceOf(TaskAccessError);
        expect(await snapshot(f)).toEqual(before);
      },
      15000,
    );

    it.each([
      ['submit', 'disabled'],
      ['claim', 'disabled'],
      ['finish', 'disabled'],
      ['submit', 'binding-changed'],
      ['claim', 'binding-changed'],
      ['finish', 'binding-changed'],
    ] as const)(
      'reauthorizes the exact personal model when %s waits behind a %s change',
      async (stage, change) => {
        const f = await fixture(),
          task = stage === 'submit' ? undefined : await submit(f);
        const admitted = stage === 'finish' ? await claim() : undefined;
        const before = await snapshot(f);
        const result = await duringWait<unknown>(
          f,
          (pool) =>
            stage === 'submit'
              ? submit(f, pool)
              : stage === 'claim'
                ? new TaskQueue(pool).claimNext()
                : new TaskQueue(pool).finish(admitted!, { body: 'Must not publish.', usage: null }),
          (connection) =>
            connection.query(
              change === 'disabled'
                ? "UPDATE personal_model_connections SET metadata=jsonb_set(metadata,'{enabled}','false'::jsonb),revision=revision+1 WHERE owner_user_id=$1 AND id=$2"
                : `UPDATE personal_model_connections SET metadata=jsonb_set(metadata,'{modelId}','"replacement-model"'::jsonb),revision=revision+1 WHERE owner_user_id=$1 AND id=$2`,
              [f.ownerId, f.model.id],
            ),
          true,
        );
        if (stage === 'submit') {
          expect(result).toMatchObject({ status: 'rejected', reason: expect.any(ProviderError) });
          expect(await snapshot(f)).toEqual(before);
        } else {
          expect(result.status).toBe('fulfilled');
          expect(await read(f, task!.id)).toMatchObject({
            status: 'failed',
            runs: [{ error: 'model_unavailable', output: null }],
          });
          expect((await snapshot(f)).events).toHaveLength(1);
        }
      },
      15000,
    );

    it('rejects expired output in PostgreSQL and conditionally fails the retained claim at its persisted deadline', async () => {
      const f = await fixture(),
        task = await submit(f);
      // Persist a valid but already expired claim without sleeping or rewriting
      // its immutable deadline. The PG output guard still uses its real clock.
      const oldClock = () => new Date(Date.now() - 600000);
      const selected = await new TaskQueue(runtime, oldClock).claimNext();
      expect(selected.claim).toBeDefined();
      const admitted = selected.claim!;
      expect(admitted.deadlineAt.getTime()).toBeLessThan(Date.now());
      const canonical = {
        taskId: task.id,
        runId: admitted.runId,
        bot: {
          id: f.bot.id,
          displayName: task.bot.name,
          versionId: task.bot.versionId,
          versionNumber: task.bot.versionNumber,
        },
      };
      await expect(
        runtime.query(
          `INSERT INTO conversation_events(id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,idempotency_key,command_hash,event_data,bot_run_id)
         VALUES($1,$2,2,$3,1,'bot.message.created',$4,NOW(),'Expired output.',$5,$6,$7::jsonb,$8)`,
          [
            randomUUID(),
            f.conversationId,
            randomUUID(),
            f.actorId,
            randomUUID(),
            'c'.repeat(64),
            JSON.stringify(canonical),
            admitted.runId,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        await new TaskQueue(runtime).finish(admitted, {
          body: 'Late success.',
          usage: { inputTokens: 2, outputTokens: 1 },
        }),
      ).toBe(true);
      expect(await read(f, task.id)).toMatchObject({
        status: 'failed',
        runs: [
          { error: 'execution_timeout', output: null, usage: { inputTokens: 2, outputTokens: 1 } },
        ],
      });
      expect((await snapshot(f)).events).toHaveLength(1);
    });

    it('reads the version after its submission lock wait and pins it across subsequent current-version changes', async () => {
      const f = await fixture();
      const access = { actorUserId: f.ownerId, workspaceId: f.workspaceId, botId: f.bot.id };
      const submitted = await duringWait(
        f,
        (pool) => submit(f, pool),
        (connection) =>
          appendBotVersion(connection, access, {
            kind: 'configuration',
            expectedCurrentVersionId: f.bot.currentVersion!.id,
            changes: { name: 'Version two', instructions: 'Version two instructions.' },
          }),
      );
      if (submitted.status === 'rejected') throw submitted.reason;
      const task = submitted.value;
      expect(task.bot).toMatchObject({ name: 'Version two', versionNumber: 2 });
      const connection = await runtime.connect();
      try {
        await connection.query('BEGIN');
        await appendBotVersion(connection, access, {
          kind: 'configuration',
          expectedCurrentVersionId: task.bot.versionId,
          changes: {
            name: 'Version three',
            instructions: 'New instructions must not replace the pin.',
          },
        });
        await connection.query('COMMIT');
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      const admitted = await claim();
      expect(admitted.messages[0]).toEqual({
        role: 'system',
        content: 'Version two instructions.',
      });
      await new TaskQueue(runtime).finish(admitted, {
        body: 'Pinned version answer.',
        usage: null,
      });
      expect((await read(f, task.id)).bot).toEqual(task.bot);
      const output = (
        await conversations().get(f.actorId, f.workspaceId, f.conversationId, {})
      ).messages.at(-1)!;
      expect(output.author).toMatchObject({
        kind: 'bot',
        versionId: task.bot.versionId,
        versionNumber: 2,
        displayName: 'Version two',
      });
    }, 15000);

    it.each(['claim', 'finish'] as const)(
      'reauthorizes the triggering group member after %s waits',
      async (stage) => {
        const f = await fixture('workspace', true),
          task = await submit(f),
          admitted = stage === 'finish' ? await claim() : undefined;
        const result = await duringWait<unknown>(
          f,
          (pool) =>
            stage === 'claim'
              ? new TaskQueue(pool).claimNext()
              : new TaskQueue(pool).finish(admitted!, { body: 'Must not publish.', usage: null }),
          (connection) =>
            connection.query('DELETE FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
              f.grant!.groupId,
              f.actorId,
            ]),
        );
        expect(result.status).toBe('fulfilled');
        expect(await read(f, task.id, runtime, f.ownerId)).toMatchObject({
          status: 'failed',
          executionUser: { id: f.memberId },
          runs: [{ error: 'execution_forbidden', output: null }],
        });
        expect(
          (await snapshot(f)).events.filter(
            (event: { event_type: string }) => event.event_type === 'bot.message.created',
          ),
        ).toHaveLength(0);
        await expect(read(f, task.id)).rejects.toBeInstanceOf(TaskAccessError);
      },
      15000,
    );

    it.each(['claim', 'finish'] as const)(
      'rejects the exact grant closed while %s waits and never substitutes a later invitation',
      async (stage) => {
        const f = await fixture('workspace', true),
          task = await submit(f),
          admitted = stage === 'finish' ? await claim() : undefined;
        const grant = f.grant!;
        const result = await duringWait<unknown>(
          f,
          (pool) =>
            stage === 'claim'
              ? new TaskQueue(pool).claimNext()
              : new TaskQueue(pool).finish(admitted!, {
                  body: 'Closed-grant output.',
                  usage: null,
                }),
          async (connection) => {
            await connection.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE', [grant.groupId]);
            await connection.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [f.bot.id]);
            await connection.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
              f.conversationId,
            ]);
            await closeGroupBotGrant(
              connection,
              f.ownerId,
              {
                id: grant.id,
                workspaceId: f.workspaceId,
                groupId: grant.groupId,
                botId: f.bot.id,
                conversationId: f.conversationId,
                grantorUserId: f.ownerId,
              },
              'removed',
              {
                idempotencyKey: 'close-during-wait',
                hash: createHash('sha256')
                  .update(
                    JSON.stringify({ type: 'bot.removed', grantId: grant.id, reason: 'removed' }),
                  )
                  .digest('hex'),
              },
              () => new Date(),
            );
          },
        );
        expect(result.status).toBe('fulfilled');
        const replacement = await grants().invite(f.ownerId, f.workspaceId, grant.groupId, {
          botId: f.bot.id,
          idempotencyKey: 'replacement-grant',
        });
        expect(replacement.id).not.toBe(grant.id);
        expect(await read(f, task.id)).toMatchObject({
          status: 'failed',
          groupGrantId: grant.id,
          runs: [{ error: 'execution_forbidden', output: null }],
        });
        expect(
          (
            await new TaskService(runtime).list(f.actorId, f.workspaceId, f.conversationId, {})
          ).tasks.map((item) => item.id),
        ).toEqual([task.id]);
        await expect(submit(f, runtime, 'closed-grant')).rejects.toBeInstanceOf(TaskAccessError);
        expect(
          (await snapshot(f)).events.filter(
            (event: { event_type: string }) => event.event_type === 'bot.message.created',
          ),
        ).toHaveLength(0);
      },
      15000,
    );

    it('does not borrow a grantor personal provider for the triggering group member', async () => {
      const f = await fixture('personal', true),
        before = await snapshot(f);
      await expect(submit(f)).rejects.toBeInstanceOf(ProviderError);
      expect(await snapshot(f)).toEqual(before);
      expect(
        (
          await runtime.query('SELECT user_id FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
            f.bot.id,
            f.memberId,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  },
);

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
  ModelEvent,
  ModelInput,
  ModelResponse,
  ProviderProtocol,
} from '../../src/providers/model-events.js';
import { authorizeProviderScope } from '../../src/providers/postgres-provider-scope.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { personalAccess } from '../../src/providers/scope.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderError, ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { modelFailure } from '../../src/providers/failure-taxonomy.js';
import { TaskQueue, type TaskClaim } from '../../src/tasks/queue.js';
import { writeNextAttempt } from '../../src/tasks/next-attempt.js';
import { planNextAttempt } from '../../src/tasks/retry-schedule.js';
import { planManualResume } from '../../src/tasks/resume.js';
import { createQueuedTaskChild } from '../helpers/task-tree-fixture.js';
import { TaskAccessError, TaskConflictError, TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { GroupRoutingService, RoutingSettingConflictError } from '../../src/routing/service.js';

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
      // Exercise the actual ordered migrations through 0022 and every PG guard.
      // There is deliberately no fixture-only schema or migration placeholder.
      await migrateDatabase(admin);
      const versions = (await admin.query('SELECT version FROM openbot_schema_migrations')).rows;
      expect(versions.map((row) => row.version)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^0016_/u),
          expect.stringMatching(/^0017_/u),
          expect.stringMatching(/^0018_/u),
          expect.stringMatching(/^0019_/u),
          expect.stringMatching(/^0020_/u),
          expect.stringMatching(/^0021_/u),
          expect.stringMatching(/^0022_/u),
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
      const connection = await admin.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          `UPDATE task_runs SET status='failed',finished_at=NOW(),error_code='worker_interrupted'
       WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=ANY($1::uuid[]))
       AND status='running'
       AND EXISTS (
         SELECT 1 FROM task_run_leases l
         WHERE l.run_id=task_runs.id AND l.expires_at<=clock_timestamp()
       )`,
          [ids],
        );
        await connection.query(
          `UPDATE task_runs SET status='failed',finished_at=NOW(),error_code='worker_stopped'
       WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=ANY($1::uuid[]))
       AND status IN ('queued','running')`,
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
    const grants = () => new GroupBotService(new PostgresGroupBotRepository(runtime));
    async function fixture(
      scope: 'personal' | 'workspace' = 'personal',
      inGroup = false,
      options: {
        retryPolicy?: { maxAttemptsPerModel: number; maxRunsPerChain: number };
        fallback?: boolean;
      } = {},
    ) {
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
      const connections = scope === 'workspace' ? providers.inWorkspace(workspaceId) : providers;
      const fallback = options.fallback
        ? await connections.save(ownerId, {
            protocol: 'openai-responses',
            name: 'Fallback model',
            baseUrl: 'https://models.example/v1',
            modelId: 'fallback-model',
            apiKey: 'native-task-fallback',
            headers: {},
          })
        : undefined;
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
          ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
          ...(fallback && options.retryPolicy
            ? {
                fallbackBindings: [
                  {
                    scope: { kind: scope, id: scope === 'personal' ? ownerId : workspaceId },
                    connectionId: fallback.id,
                    modelId: fallback.modelId,
                  },
                ],
              }
            : {}),
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
        fallback,
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
       (SELECT jsonb_agg(a ORDER BY a.id) FROM audit_events a WHERE metadata->>'conversationId'=$1::text) AS audits,
       (SELECT jsonb_agg(c ORDER BY c.id) FROM task_retry_commands c JOIN tasks t ON t.id=c.task_id WHERE t.conversation_id=$1) AS retries,
       (SELECT jsonb_agg(d ORDER BY d.sequence) FROM conversation_delivery_events d WHERE d.conversation_id=$1) AS delivery,
       (SELECT jsonb_agg(r ORDER BY r.sequence) FROM task_run_delivery_receipts r WHERE r.conversation_id=$1) AS delivery_receipts`,
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
      type:
        | 'task.queued'
        | 'task.running'
        | 'task.completed'
        | 'task.failed'
        | 'task.retried'
        | 'task.routed',
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

    it('serializes observed duplicate retry commands into one immutable receipt and next attempt', async () => {
      const f = await fixture(),
        task = await submit(f),
        failedClaim = await claim();
      await new TaskQueue(runtime).finish(failedClaim, {
        error: 'provider_failed',
        usage: { inputTokens: 5, outputTokens: 1 },
      });
      const before = await snapshot(f);
      const command = { idempotencyKey: 'concurrent-retry', expectedRunId: failedClaim.runId };
      const results = await contenders(f, (pool) =>
        new TaskService(pool).retry(f.actorId, f.workspaceId, f.conversationId, task.id, command),
      );
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({
        task: {
          id: task.id,
          status: 'queued',
          runCount: 2,
          trigger: task.trigger,
          runs: [{ attempt: 2, status: 'queued' }],
        },
        receipt: { attempt: 2 },
      });
      const saved = await snapshot(f);
      expect(saved.tasks).toHaveLength(1);
      expect(saved.runs).toHaveLength(2);
      expect(saved.retries).toHaveLength(1);
      expect(saved.events).toEqual(before.events);
      expect(saved.runs.find((run: { id: string }) => run.id === failedClaim.runId)).toEqual(
        before.runs[0],
      );
      const added = saved.audits.filter(
        (audit: { id: string }) =>
          !before.audits.some((previous: { id: string }) => previous.id === audit.id),
      );
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        event_type: 'task.retried',
        actor_user_id: f.actorId,
        metadata: {
          taskId: task.id,
          retryCommandId: saved.retries[0].id,
          previousRunId: failedClaim.runId,
          runId: results[0]!.receipt.runId,
          attempt: 2,
        },
      });
    }, 20000);

    it('creates only one next attempt when two different retry keys contend for one failed Run', async () => {
      const f = await fixture(),
        task = await submit(f),
        failedClaim = await claim();
      await new TaskQueue(runtime).finish(failedClaim, { error: 'provider_failed', usage: null });
      const results = await contenders(f, async (pool) => {
        try {
          return {
            receipt: (
              await new TaskService(pool).retry(
                f.actorId,
                f.workspaceId,
                f.conversationId,
                task.id,
                { idempotencyKey: randomUUID(), expectedRunId: failedClaim.runId },
              )
            ).receipt,
          };
        } catch (error) {
          if (error instanceof TaskConflictError) return { code: error.code };
          throw error;
        }
      });
      expect(results.filter((result) => result.receipt)).toHaveLength(1);
      expect(results.filter((result) => result.code)).toEqual([
        { code: 'task_retry_state_conflict' },
      ]);
      const saved = await snapshot(f);
      expect(saved.retries).toHaveLength(1);
      expect(saved.runs).toHaveLength(2);
    }, 20000);

    it('rolls back the next Run, retry receipt, Task state and ordered ledger when its mandatory retry audit fails', async () => {
      const f = await fixture(),
        task = await submit(f),
        failedClaim = await claim();
      await new TaskQueue(runtime).finish(failedClaim, { error: 'provider_failed', usage: null });
      const before = await snapshot(f);
      await rejectingAudit('task.retried', () =>
        new TaskService(runtime).retry(f.actorId, f.workspaceId, f.conversationId, task.id, {
          idempotencyKey: 'atomic-retry',
          expectedRunId: failedClaim.runId,
        }),
      );
      expect(await snapshot(f)).toEqual(before);
    });

    it('completes a retried Run with fresh credentials while fencing all old output and preserving its failed evidence', async () => {
      const f = await fixture(),
        task = await submit(f),
        oldClaim = await claim();
      const queue = new TaskQueue(runtime);
      await queue.finish(oldClaim, {
        error: 'provider_failed',
        usage: { inputTokens: 7, outputTokens: 2 },
      });
      const original = (await snapshot(f)).runs[0];
      await f.providers.update(f.ownerId, f.model.id, { apiKey: 'rotated-native-task-credential' });
      const command = { idempotencyKey: 'retry-success', expectedRunId: oldClaim.runId };
      const retried = await new TaskService(runtime).retry(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
        command,
      );
      let calls = 0;
      expect(
        await worker(f, async (input, _signal, observe) => {
          calls++;
          expect(input.apiKey).toBe('rotated-native-task-credential');
          expect(input.modelId).toBe('task-model');
          const beforeLate = await snapshot(f);
          expect(
            await queue.finish(oldClaim, { body: 'Late old final answer.', usage: null }),
          ).toBe(false);
          await expect(queue.publishDelta(oldClaim, 'Late old preview.')).rejects.toMatchObject({
            code: 'worker_stopped',
          });
          expect(await snapshot(f)).toEqual(beforeLate);
          const events: ModelEvent[] = [
            { type: 'text', text: 'One current retry answer.' },
            { type: 'usage', inputTokens: 8, outputTokens: 4 },
            { type: 'complete', stopReason: 'stop' },
          ];
          for (const event of events) await observe?.(event);
          return { events, raw: 'private provider response' };
        }).runOnce(),
      ).toBe(true);
      expect(calls).toBe(1);
      expect(await queue.claimNext()).toEqual({ handled: false });
      const current = await read(f, task.id),
        saved = await snapshot(f);
      expect(current).toMatchObject({
        status: 'completed',
        runCount: 2,
        trigger: task.trigger,
        runs: [
          {
            id: retried.receipt.runId,
            attempt: 2,
            status: 'completed',
            usage: { inputTokens: 8, outputTokens: 4 },
          },
        ],
      });
      expect(saved.runs.find((run: { id: string }) => run.id === oldClaim.runId)).toEqual(original);
      expect(
        saved.runs.find((run: { id: string }) => run.id === retried.receipt.runId)
          .connection_revision,
      ).toBe(original.connection_revision + 1);
      const outputs = saved.events.filter(
        (event: { event_type: string }) => event.event_type === 'bot.message.created',
      );
      expect(outputs).toHaveLength(1);
      expect(current.runs[0]!.output).toEqual({
        messageId: outputs[0].message_id,
        eventId: outputs[0].id,
        sequence: outputs[0].sequence,
      });
      expect(
        await new TaskService(runtime).retry(
          f.actorId,
          f.workspaceId,
          f.conversationId,
          task.id,
          command,
        ),
      ).toEqual({ task: current, receipt: retried.receipt });
      await expect(
        new TaskService(runtime).retry(f.actorId, f.workspaceId, f.conversationId, task.id, {
          idempotencyKey: 'completed-new-retry',
          expectedRunId: retried.receipt.runId,
        }),
      ).rejects.toMatchObject({ code: 'task_retry_state_conflict' });
      await f.providers.disable(f.ownerId, f.model.id);
      const history = await new TaskService(runtime).runs(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
        { cursor: current.olderRunsCursor },
      );
      expect(history.runs).toHaveLength(1);
      expect(history.runs[0]).toMatchObject({
        id: oldClaim.runId,
        attempt: 1,
        status: 'failed',
        error: 'provider_failed',
        provider: { modelId: 'task-model' },
      });
    }, 20000);

    it('rechecks original model admission after an observed provider lock wait and leaves no retry receipt', async () => {
      const f = await fixture(),
        task = await submit(f),
        failedClaim = await claim();
      await new TaskQueue(runtime).finish(failedClaim, { error: 'provider_failed', usage: null });
      const before = await snapshot(f);
      const result = await duringWait(
        f,
        (pool) =>
          new TaskService(pool).retry(f.actorId, f.workspaceId, f.conversationId, task.id, {
            idempotencyKey: 'wait-model',
            expectedRunId: failedClaim.runId,
          }),
        async (connection) => {
          await connection.query(
            "UPDATE personal_model_connections SET metadata=jsonb_set(metadata,'{enabled}','false'),revision=revision+1 WHERE id=$1",
            [f.model.id],
          );
        },
        true,
      );
      expect(result).toMatchObject({ status: 'rejected', reason: expect.any(ProviderError) });
      expect(await snapshot(f)).toEqual(before);
    }, 20000);

    it('reauthorizes an existing retry receipt after an observed exact-grant revocation', async () => {
      const f = await fixture('workspace', true),
        task = await submit(f),
        failedClaim = await claim();
      await new TaskQueue(runtime).finish(failedClaim, { error: 'provider_failed', usage: null });
      const command = { idempotencyKey: 'retained-receipt', expectedRunId: failedClaim.runId };
      const retried = await new TaskService(runtime).retry(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
        command,
      );
      const result = await duringWait(
        f,
        (pool) =>
          new TaskService(pool).retry(f.actorId, f.workspaceId, f.conversationId, task.id, command),
        async (connection) => {
          const grant = f.grant!;
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
              idempotencyKey: 'close-retry-grant',
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
      expect(result).toMatchObject({ status: 'rejected', reason: expect.any(TaskAccessError) });
      const saved = await snapshot(f);
      expect(saved.retries).toHaveLength(1);
      expect(saved.runs).toHaveLength(2);
      expect((await read(f, task.id)).runs[0]!.id).toBe(retried.receipt.runId);
      expect(
        (
          await new TaskService(runtime).runs(f.actorId, f.workspaceId, f.conversationId, task.id, {
            cursor: retried.task.olderRunsCursor,
          })
        ).runs.map((run) => run.id),
      ).toEqual([failedClaim.runId]);
    }, 20000);

    it('retains retry commands and rejects terminal edits or an orphan next Run even for the migration owner', async () => {
      const f = await fixture(),
        task = await submit(f),
        failedClaim = await claim();
      await new TaskQueue(runtime).finish(failedClaim, { error: 'provider_failed', usage: null });
      const before = await snapshot(f);
      await expect(
        admin.query(
          "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,2,'queued',NOW())",
          [randomUUID(), task.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(f)).toEqual(before);
      const retried = await new TaskService(runtime).retry(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
        { idempotencyKey: 'immutable-retry', expectedRunId: failedClaim.runId },
      );
      const saved = await snapshot(f);
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
              'task_retry_commands',
              privilege,
            ])
          ).rows[0].allowed,
        ).toBe(['SELECT', 'INSERT'].includes(privilege));
      }
      for (const pool of [runtime, admin]) {
        await expect(
          pool.query(
            "UPDATE task_runs SET status='queued',finished_at=NULL,error_code=NULL WHERE id=$1",
            [failedClaim.runId],
          ),
        ).rejects.toMatchObject({ code: '55000' });
        await expect(
          pool.query('UPDATE task_retry_commands SET run_id=$2 WHERE id=$1', [
            saved.retries[0].id,
            failedClaim.runId,
          ]),
        ).rejects.toMatchObject({ code: pool === runtime ? '42501' : '55000' });
        await expect(
          pool.query('DELETE FROM task_retry_commands WHERE id=$1', [saved.retries[0].id]),
        ).rejects.toMatchObject({ code: pool === runtime ? '42501' : '55000' });
        await expect(pool.query('TRUNCATE task_retry_commands')).rejects.toMatchObject({
          code: pool === runtime ? '42501' : '55000',
        });
      }
      expect(await snapshot(f)).toEqual(saved);
      expect((await read(f, task.id)).runs[0]!.id).toBe(retried.receipt.runId);
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
        const before = await snapshot(f);
        expect(before.audits).toEqual([
          expect.objectContaining({
            event_type: 'conversation.created',
            actor_user_id: f.actorId,
            metadata: {
              workspaceId: f.workspaceId,
              conversationId: f.conversationId,
              subject: { kind: 'direct-bot', id: f.bot.id },
            },
          }),
        ]);
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
        expect(saved.events).toEqual([
          expect.objectContaining({
            id: first!.trigger.eventId,
            message_id: first!.trigger.messageId,
            sequence: first!.trigger.sequence,
            event_type: 'message.created',
            actor_user_id: f.actorId,
            body: 'Explain the evidence.',
          }),
        ]);
        expect(saved.tasks).toHaveLength(1);
        expect(saved.runs).toHaveLength(1);
        expect(saved.audits).toHaveLength(before.audits.length + 2);
        expect(saved.audits).toEqual(
          expect.arrayContaining([
            ...before.audits,
            expect.objectContaining({
              event_type: 'conversation.message_created',
              actor_user_id: f.actorId,
              metadata: {
                workspaceId: f.workspaceId,
                conversationId: f.conversationId,
                messageId: first!.trigger.messageId,
                eventId: first!.trigger.eventId,
                sequence: first!.trigger.sequence,
              },
            }),
            expect.objectContaining({
              event_type: 'task.queued',
              actor_user_id: f.actorId,
              metadata: {
                workspaceId: f.workspaceId,
                conversationId: f.conversationId,
                taskId: first!.id,
                runId: first!.runs[0]!.id,
                botId: f.bot.id,
                botVersionId: f.bot.currentVersion!.id,
                triggerEventId: first!.trigger.eventId,
                attempt: 1,
              },
            }),
          ]),
        );
        expect(first!.trigger.sequence).toBe(1);
        const delivery = (
          await runtime.query(
            'SELECT sequence,event_type,ledger_event_id,run_id,run_status,execution FROM conversation_delivery_events WHERE conversation_id=$1 ORDER BY sequence',
            [f.conversationId],
          )
        ).rows.map((event) => ({ ...event, sequence: Number(event.sequence) }));
        expect(delivery).toEqual([
          {
            sequence: first!.trigger.sequence,
            event_type: 'message.changed',
            ledger_event_id: first!.trigger.eventId,
            run_id: null,
            run_status: null,
            execution: null,
          },
          {
            sequence: first!.trigger.sequence + 1,
            event_type: 'task.run.updated',
            ledger_event_id: null,
            run_id: first!.runs[0]!.id,
            run_status: 'queued',
            execution: expect.objectContaining({
              taskId: first!.id,
              runId: first!.runs[0]!.id,
              attempt: 1,
              taskStatus: 'queued',
              runStatus: 'queued',
            }),
          },
        ]);
        const queuedSequence = delivery[1]!.sequence;
        expect(saved.conversation.last_sequence).toBe(queuedSequence);
        const receipts = (
          await runtime.query(
            'SELECT run_id,run_status,conversation_id,sequence FROM task_run_delivery_receipts WHERE conversation_id=$1',
            [f.conversationId],
          )
        ).rows.map((receipt) => ({ ...receipt, sequence: Number(receipt.sequence) }));
        expect(receipts).toEqual([
          {
            run_id: first!.runs[0]!.id,
            run_status: 'queued',
            conversation_id: f.conversationId,
            sequence: queuedSequence,
          },
        ]);
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
        const outputs = (
          await rebuilt.pool.query(
            "SELECT id,message_id,sequence FROM conversation_events WHERE conversation_id=$1 AND bot_run_id=$2 AND event_type='bot.message.created'",
            [f.conversationId, final.runs[0]!.id],
          )
        ).rows;
        expect(outputs).toHaveLength(1);
        const output = outputs[0]!;
        expect(Number(output.sequence)).toBeGreaterThan(task.trigger.sequence);
        expect(final).toMatchObject({
          status: 'completed',
          bot: { versionId: task.bot.versionId },
          runs: [
            {
              attempt: 1,
              status: 'completed',
              usage: { inputTokens: 5, outputTokens: 3 },
              error: null,
              output: {
                messageId: output.message_id,
                eventId: output.id,
                sequence: Number(output.sequence),
              },
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
        const audits: { event_type: string; actor_user_id: string }[] = (
          await snapshot(f)
        ).audits.filter(
          (audit: { event_type: string }) =>
            audit.event_type.startsWith('task.') ||
            audit.event_type === 'conversation.bot_message_created',
        );
        expect(
          audits
            .map((audit: { event_type: string; actor_user_id: string }) => ({
              eventType: audit.event_type,
              actorUserId: audit.actor_user_id,
            }))
            .sort((left, right) => left.eventType.localeCompare(right.eventType)),
        ).toEqual(
          [
            'conversation.bot_message_created',
            'task.completed',
            'task.queued',
            'task.routed',
            'task.running',
          ].map((eventType) => ({ eventType, actorUserId: f.memberId })),
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
       SELECT $1,id,last_sequence+1,$3,1,'bot.message.created',$4,NOW(),'Forged Bot identity.',$5,$6,'{}'::jsonb,$7 FROM conversations WHERE id=$2`,
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
         SELECT $1,id,last_sequence+1,$3,2,'message.edited',$4,NOW(),'Human forgery.',$5,$6,'{}'::jsonb FROM conversations WHERE id=$2`,
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
         SELECT $1,id,last_sequence+1,$3,1,'bot.message.created',$4,NOW(),'Expired output.',$5,$6,$7::jsonb,$8 FROM conversations WHERE id=$2`,
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
      ).rejects.toMatchObject({
        code: '55000',
        message: 'only the current live Run can publish',
      });
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
      const stored = await snapshot(f);
      expect(stored.events).toHaveLength(1);
      expect(
        stored.events.some(
          (event: { event_type: string }) => event.event_type === 'task.limit.warning',
        ),
      ).toBe(false);
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

    const automatic = (f: Fixture, pool = runtime, key = 'routed-turn') =>
      new TaskService(pool).submit(f.actorId, f.workspaceId, f.conversationId, {
        idempotencyKey: key,
        body: 'Explain the evidence.',
      });
    const routing = (f: Fixture, taskId: string, pool = runtime) =>
      new TaskService(pool).routing(f.actorId, f.workspaceId, f.conversationId, taskId);
    async function routedSnapshot(f: Fixture) {
      return {
        ...(await snapshot(f)),
        decisions: (
          await admin.query(
            'SELECT * FROM task_routing_decisions WHERE conversation_id=$1 ORDER BY task_id',
            [f.conversationId],
          )
        ).rows,
      };
    }
    async function anotherRoutingBot(f: Fixture) {
      const bot = await new BotService(new PostgresBotRepository(runtime)).create(
        f.ownerId,
        f.workspaceId,
        {
          name: 'Second helper',
          roleDescription: 'Reasoning assistant',
          instructions: 'Private second instructions',
          modelBinding: {
            scope: { kind: 'workspace', id: f.workspaceId },
            connectionId: f.model.id,
            modelId: f.model.modelId,
          },
        },
      );
      return grants().invite(f.ownerId, f.workspaceId, f.grant!.groupId, {
        botId: bot.id,
        idempotencyKey: 'second-routing-grant',
      });
    }

    it('routes observed concurrent identical commands once, then invokes only their selected Lead', async () => {
      const f = await fixture('workspace', true);
      const generate = vi.fn<ModelAdapter['generate']>(async (_input, _signal, observe) => {
        const events: ModelResponse['events'] = [
          { type: 'text', text: 'One routed answer.' },
          { type: 'complete', stopReason: 'stop' },
        ];
        for (const event of events) await observe?.(event);
        return { events, raw: '' };
      });
      const [first, duplicate] = await contenders(f, (pool) => automatic(f, pool));
      expect(duplicate).toEqual(first);
      expect(first).toMatchObject({
        groupGrantId: f.grant!.id,
        routing: { algorithm: 'local-terms-v1', reason: 'local-match' },
      });
      expect(generate).not.toHaveBeenCalled();
      const stored = await routedSnapshot(f);
      expect(stored.tasks).toHaveLength(1);
      expect(stored.runs).toHaveLength(1);
      expect(stored.decisions).toHaveLength(1);
      expect(
        stored.audits.filter((audit: { event_type: string }) => audit.event_type === 'task.routed'),
      ).toHaveLength(1);
      expect(stored.tasks[0].command_hash).toBe(
        stored.events.find((event: { id: string }) => event.id === first!.trigger.eventId)
          .command_hash,
      );
      expect(await worker(f, generate).runOnce()).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await read(f, first!.id)).toMatchObject({ status: 'completed' });
      expect(
        (await routedSnapshot(f)).events.filter(
          (event: { event_type: string }) => event.event_type === 'bot.message.created',
        ),
      ).toHaveLength(1);
    }, 15000);

    it('preserves original routing across default changes, restart and permanent grant replacement', async () => {
      const f = await fixture('workspace', true);
      const first = await automatic(f),
        evidence = await routing(f, first.id);
      const other = await anotherRoutingBot(f);
      await new GroupRoutingService(runtime).update(f.ownerId, f.workspaceId, f.grant!.groupId, {
        expectedRevision: 0,
        defaultGrantId: other.id,
      });
      const rebuilt = observedPool();
      try {
        expect(await automatic(f, rebuilt.pool)).toEqual(first);
        expect(await routing(f, first.id, rebuilt.pool)).toEqual(evidence);
        expect(await automatic(f, rebuilt.pool, 'new-turn')).toMatchObject({
          groupGrantId: other.id,
          routing: { reason: 'default' },
        });
      } finally {
        await rebuilt.pool.end();
      }
      await grants().remove(f.ownerId, f.workspaceId, f.grant!.groupId, f.grant!.id, {
        idempotencyKey: 'close-routed-grant',
      });
      const replacement = await grants().invite(f.ownerId, f.workspaceId, f.grant!.groupId, {
        botId: f.bot.id,
        idempotencyKey: 'replace-routed-grant',
      });
      expect(replacement.id).not.toBe(f.grant!.id);
      await expect(automatic(f)).rejects.toBeInstanceOf(TaskAccessError);
      expect(await routing(f, first.id)).toEqual(evidence);
    });

    it('rechecks candidate lifecycle after an observed structural admission wait', async () => {
      const f = await fixture('workspace', true),
        before = await routedSnapshot(f);
      const result = await duringWait(
        f,
        (pool) => automatic(f, pool),
        (holder) =>
          holder.query("UPDATE bots SET lifecycle_state='archived' WHERE id=$1", [f.bot.id]),
      );
      expect(result).toMatchObject({ status: 'rejected', reason: { code: 'no_eligible_bot' } });
      expect(await routedSnapshot(f)).toEqual(before);
    }, 15000);

    it('rechecks the actual human membership after an observed routing admission wait', async () => {
      const f = await fixture('workspace', true),
        before = await routedSnapshot(f);
      const result = await duringWait(
        f,
        (pool) => automatic(f, pool),
        (holder) =>
          holder.query('DELETE FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
            f.grant!.groupId,
            f.actorId,
          ]),
      );
      expect(result).toMatchObject({ status: 'rejected', reason: expect.any(TaskAccessError) });
      expect(await routedSnapshot(f)).toEqual(before);
    }, 15000);

    it('rolls back the trigger, sequence, Task, Run and routing evidence when its final routing audit fails', async () => {
      const f = await fixture('workspace', true),
        before = await routedSnapshot(f);
      await rejectingAudit('task.routed', () => automatic(f));
      expect(await routedSnapshot(f)).toEqual(before);
      await automatic(f);
      expect((await routedSnapshot(f)).decisions).toHaveLength(1);
    });

    it('enforces immutable routing receipts and same-scope identities under the deployed role', async () => {
      const f = await fixture('workspace', true),
        task = await automatic(f);
      const before = await routing(f, task.id);
      await expect(
        runtime.query('UPDATE task_routing_decisions SET reason=$2 WHERE task_id=$1', [
          task.id,
          'mention',
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query('DELETE FROM task_routing_decisions WHERE task_id=$1', [task.id]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.query('TRUNCATE task_routing_decisions')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        admin.query('UPDATE task_routing_decisions SET reason=$2 WHERE task_id=$1', [
          task.id,
          'mention',
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        admin.query('DELETE FROM task_routing_decisions WHERE task_id=$1', [task.id]),
      ).rejects.toMatchObject({ code: '55000' });
      const wrong = await fixture('workspace', true);
      await expect(
        runtime.query(
          `INSERT INTO task_routing_decisions(task_id,workspace_id,conversation_id,group_id,request_hash,algorithm,reason,decision,created_at)
         SELECT task_id,$2,conversation_id,group_id,request_hash,algorithm,reason,decision,created_at FROM task_routing_decisions WHERE task_id=$1`,
          [task.id, wrong.workspaceId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(runtime.query('SELECT protect_task_routing_decision()')).rejects.toMatchObject({
        code: '42501',
      });
      expect(await routing(f, task.id)).toEqual(before);
    });

    it('serializes competing default changes with one CAS revision and mandatory safe audit', async () => {
      const f = await fixture('workspace', true),
        other = await anotherRoutingBot(f);
      let index = 0;
      const results = await contenders(f, async (pool) => {
        const grantId = index++ === 0 ? f.grant!.id : other.id;
        try {
          return {
            value: await new GroupRoutingService(pool).update(
              f.ownerId,
              f.workspaceId,
              f.grant!.groupId,
              { expectedRevision: 0, defaultGrantId: grantId },
            ),
          };
        } catch (error) {
          return { error };
        }
      });
      expect(results.filter((result) => result.value)).toHaveLength(1);
      expect(
        results.filter((result) => result.error instanceof RoutingSettingConflictError),
      ).toHaveLength(1);
      expect(
        await new GroupRoutingService(runtime).get(f.actorId, f.workspaceId, f.grant!.groupId),
      ).toMatchObject({ revision: 1, canManage: false });
      expect(
        (
          await admin.query(
            "SELECT id FROM audit_events WHERE event_type='group.routing_updated' AND metadata->>'groupId'=$1",
            [f.grant!.groupId],
          )
        ).rows,
      ).toHaveLength(1);
    }, 15000);

    it('schedules a transient later attempt under runtime privileges without a human retry command', async () => {
      const f = await fixture('personal', false, {
        retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
      });
      let now = new Date();
      const queue = new TaskQueue(runtime, () => now);
      const task = await submit(f);
      const selected = await queue.claimNext();
      expect(selected.claim).toBeDefined();
      expect(
        await queue.finish(selected.claim!, {
          error: 'provider_failed',
          usage: { inputTokens: 3, outputTokens: 1 },
          modelFailure: modelFailure('provider_rate_limited'),
        }),
      ).toBe(true);
      const runs = (
        await runtime.query(
          'SELECT id,attempt,status,error_code FROM task_runs WHERE task_id=$1 ORDER BY attempt',
          [task.id],
        )
      ).rows;
      expect(runs).toMatchObject([
        { attempt: 1, status: 'failed', error_code: 'provider_failed' },
        { attempt: 2, status: 'queued', error_code: null },
      ]);
      expect(
        (await runtime.query('SELECT id FROM task_retry_commands WHERE task_id=$1', [task.id]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await runtime.query('SELECT id FROM tasks WHERE conversation_id=$1', [f.conversationId]))
          .rows,
      ).toHaveLength(1);
      const queued = (
        await runtime.query<{ metadata: Record<string, unknown> }>(
          'SELECT task_queued_audit_metadata($1::uuid) AS metadata',
          [runs[1]!.id],
        )
      ).rows[0]!.metadata;
      expect(queued).toMatchObject({
        origin: 'provider_retry',
        sourceRunId: runs[0]!.id,
        reason: 'provider_rate_limited',
      });
      now = new Date(String(queued.notBefore));
      expect(await queue.claimNext()).toMatchObject({
        handled: true,
        claim: { provider: { connectionId: f.model.id, modelId: f.model.modelId } },
      });
    });

    it('does not schedule authentication failures and leaves one Task with no Bot message', async () => {
      const f = await fixture('personal', false, {
        retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
      });
      const queue = new TaskQueue(runtime);
      const task = await submit(f);
      const selected = await queue.claimNext();
      await queue.finish(selected.claim!, {
        error: 'provider_failed',
        usage: null,
        modelFailure: modelFailure('provider_authentication_failed'),
      });
      expect(await read(f, task.id)).toMatchObject({
        status: 'failed',
        runCount: 1,
        runs: [{ status: 'failed', error: 'provider_failed' }],
      });
      expect(
        (await runtime.query('SELECT id FROM task_runs WHERE task_id=$1', [task.id])).rows,
      ).toHaveLength(1);
      expect(
        (
          await runtime.query(
            "SELECT id FROM conversation_events WHERE conversation_id=$1 AND event_type='bot.message.created'",
            [f.conversationId],
          )
        ).rows,
      ).toHaveLength(0);
    });

    it('claims only a version-listed fallback after the per-model cap and rejects an unlisted binding', async () => {
      const f = await fixture('personal', false, {
        retryPolicy: { maxAttemptsPerModel: 1, maxRunsPerChain: 4 },
        fallback: true,
      });
      let now = new Date();
      const queue = new TaskQueue(runtime, () => now);
      const task = await submit(f);
      const selected = await queue.claimNext();
      await queue.finish(selected.claim!, {
        error: 'provider_failed',
        usage: null,
        modelFailure: modelFailure('provider_unavailable'),
      });
      const runs = (
        await runtime.query(
          'SELECT id,attempt,status FROM task_runs WHERE task_id=$1 ORDER BY attempt',
          [task.id],
        )
      ).rows;
      expect(runs).toHaveLength(2);
      const queued = (
        await runtime.query<{ metadata: Record<string, unknown> }>(
          'SELECT task_queued_audit_metadata($1::uuid) AS metadata',
          [runs[1]!.id],
        )
      ).rows[0]!.metadata;
      expect(queued).toMatchObject({
        origin: 'model_fallback',
        binding: { connectionId: f.fallback!.id, modelId: f.fallback!.modelId },
      });
      await expect(
        runtime.query(
          `UPDATE task_runs SET status='running',started_at=NOW(),claim_token=$2,deadline_at=NOW()+'5 minutes',
            provider_scope_kind='personal',provider_scope_id=$3,connection_id=$4,connection_revision=1,
            protocol='openai-responses',model_id='unlisted-model'
           WHERE id=$1`,
          [runs[1]!.id, randomUUID(), f.ownerId, f.model.id],
        ),
      ).rejects.toThrow(/admitted model binding/u);
      now = new Date(String(queued.notBefore));
      expect(await queue.claimNext()).toMatchObject({
        handled: true,
        claim: { provider: { connectionId: f.fallback!.id, modelId: f.fallback!.modelId } },
      });
    });

    it('serializes competing automatic writers into one successor with observed lock waits', async () => {
      const f = await fixture();
      const task = await submit(f);
      const failedClaim = await claim();
      await new TaskQueue(runtime).finish(failedClaim, {
        error: 'provider_failed',
        usage: null,
        modelFailure: modelFailure('provider_rate_limited'),
      });
      expect(
        (await runtime.query('SELECT id FROM task_runs WHERE task_id=$1', [task.id])).rows,
      ).toHaveLength(1);
      const binding = {
        scope: { kind: 'personal' as const, id: f.ownerId },
        connectionId: f.model.id,
        modelId: f.model.modelId,
      };
      const plan = planNextAttempt({
        failure: modelFailure('provider_rate_limited'),
        configuration: {
          modelBinding: binding,
          retryPolicy: { maxAttemptsPerModel: 3, maxRunsPerChain: 4 },
        },
        chain: {
          rootRunId: failedClaim.runId,
          previousRunId: failedClaim.runId,
          attempts: [
            {
              runId: failedClaim.runId,
              connectionId: f.model.id,
              modelId: f.model.modelId,
              origin: 'initial',
            },
          ],
        },
        now: new Date(),
        jitterMs: 0,
      })!;
      const holder = await runtime.connect();
      const observers = [observedPool(), observedPool()];
      const actions: Promise<Awaited<ReturnType<typeof writeNextAttempt>>>[] = [];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [task.id]);
        const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        for (const observer of observers) {
          actions.push(
            (async () => {
              const connection = await observer.pool.connect();
              try {
                await connection.query('BEGIN');
                const result = await writeNextAttempt(connection, {
                  taskId: task.id,
                  sourceRunId: failedClaim.runId,
                  workspaceId: f.workspaceId,
                  conversationId: f.conversationId,
                  executionUserId: f.actorId,
                  sourceAttempt: 1,
                  plan,
                  now: new Date(),
                });
                await connection.query('COMMIT');
                return result;
              } catch (error) {
                await connection.query('ROLLBACK');
                throw error;
              } finally {
                connection.release();
              }
            })(),
          );
        }
        const settled = Promise.allSettled(actions);
        for (const observer of observers) await blocked(observer.name, pid);
        await holder.query('COMMIT');
        const results = await Promise.all(actions);
        expect(results.filter((result) => result.scheduled)).toHaveLength(1);
        expect(
          results.filter((result) => !result.scheduled && result.reason === 'duplicate'),
        ).toHaveLength(1);
        await settled;
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await Promise.allSettled(actions);
        await Promise.all(observers.map(({ pool }) => pool.end()));
      }
      expect(
        (await runtime.query('SELECT id FROM task_runs WHERE task_id=$1', [task.id])).rows,
      ).toHaveLength(2);
      expect(
        (await runtime.query('SELECT id FROM task_retry_commands WHERE task_id=$1', [task.id]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await runtime.query('SELECT id FROM tasks WHERE conversation_id=$1', [f.conversationId]))
          .rows,
      ).toHaveLength(1);
    }, 20000);

    it('rejects a forged failed-to-queued advance without a continuation receipt and keeps immutability', async () => {
      const f = await fixture();
      const task = await submit(f);
      const failedClaim = await claim();
      await new TaskQueue(runtime).finish(failedClaim, { error: 'provider_failed', usage: null });
      const connection = await runtime.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,2,'queued',NOW())",
          [randomUUID(), task.id],
        );
        await expect(
          connection.query("UPDATE tasks SET status='queued' WHERE id=$1", [task.id]),
        ).rejects.toThrow(/immutable receipt/u);
        await connection.query('ROLLBACK');
      } finally {
        connection.release();
      }
      await expect(
        runtime.query("UPDATE task_runs SET status='queued' WHERE id=$1", [failedClaim.runId]),
      ).rejects.toThrow(/immutable/u);
      expect(
        (await runtime.query('SELECT status FROM tasks WHERE id=$1', [task.id])).rows[0],
      ).toEqual({ status: 'failed' });
      expect(
        (await runtime.query('SELECT id FROM task_runs WHERE task_id=$1', [task.id])).rows,
      ).toHaveLength(1);
    });

    it('pauses a queued Task under openbot_runtime, holds no claim, and resumes once without mutating the interrupted Run', async () => {
      const f = await fixture();
      const task = await submit(f);
      const queued = (
        await runtime.query<{ id: string }>(
          'SELECT id FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1',
          [task.id],
        )
      ).rows[0]!;
      const paused = await new TaskService(runtime).pause(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
        { idempotencyKey: 'native-pause', expectedRunId: queued.id },
      );
      expect(paused.task.status).toBe('paused');
      expect(paused.pause).toMatchObject({
        runId: queued.id,
        attempt: 1,
        affectedTaskCount: 1,
        affectedRunCount: 1,
      });
      const interrupted = (
        await runtime.query(
          'SELECT id,attempt,status,finished_at,started_at,claim_token,error_code,output_event_id FROM task_runs WHERE id=$1',
          [queued.id],
        )
      ).rows[0];
      expect(interrupted).toMatchObject({
        status: 'paused',
        started_at: null,
        claim_token: null,
        error_code: null,
        output_event_id: null,
      });
      expect(
        (
          await runtime.query(
            'SELECT strategy,schema_version,end_byte FROM task_run_pause_checkpoints WHERE run_id=$1',
            [queued.id],
          )
        ).rows,
      ).toEqual([{ strategy: 'restart_from_task_input_v1', schema_version: 1, end_byte: 0 }]);
      expect(await new TaskQueue(runtime).claimNext()).toEqual({ handled: false });
      expect(
        (
          await admin.query(
            "SELECT has_function_privilege('openbot_runtime',$1,'EXECUTE') AS allowed",
            ['task_has_manual_resume_receipt(uuid,uuid,uuid)'],
          )
        ).rows[0].allowed,
      ).toBe(true);
      expect(
        (
          await admin.query("SELECT has_function_privilege('public',$1,'EXECUTE') AS allowed", [
            'task_has_manual_resume_receipt(uuid,uuid,uuid)',
          ])
        ).rows[0].allowed,
      ).toBe(false);
      const forged = await runtime.connect();
      try {
        await forged.query('BEGIN');
        await expect(
          forged.query("UPDATE task_runs SET status='paused',finished_at=NOW() WHERE id=$1", [
            queued.id,
          ]),
        ).rejects.toThrow(/command marker|immutable/u);
        await forged.query('ROLLBACK');
      } finally {
        forged.release();
      }
      const now = new Date();
      const connection = await runtime.connect();
      let first: Awaited<ReturnType<typeof writeNextAttempt>>;
      try {
        await connection.query('BEGIN');
        first = await writeNextAttempt(connection, {
          taskId: task.id,
          sourceRunId: queued.id,
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
          executionUserId: f.actorId,
          sourceAttempt: 1,
          plan: planManualResume({
            binding: {
              scope: { kind: 'personal', id: f.ownerId },
              connectionId: f.model.id,
              modelId: f.model.modelId,
            },
            sourceRunId: queued.id,
            chainRootRunId: queued.id,
            chainAttemptOrdinal: 2,
            chainLimitSnapshot: 4,
            now,
          }),
          now,
        });
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
      expect(first).toMatchObject({ scheduled: true, runId: expect.any(String) });
      const runs = (
        await runtime.query(
          'SELECT id,attempt,status,finished_at,started_at,claim_token,error_code,output_event_id FROM task_runs WHERE task_id=$1 ORDER BY attempt',
          [task.id],
        )
      ).rows;
      expect(runs).toHaveLength(2);
      expect(runs[0]).toEqual(interrupted);
      expect(runs[1]).toMatchObject({
        id: first.scheduled ? first.runId : '',
        attempt: 2,
        status: 'queued',
      });
      expect(
        (
          await runtime.query<{ metadata: Record<string, unknown> }>(
            'SELECT task_queued_audit_metadata($1::uuid) AS metadata',
            [runs[1]!.id],
          )
        ).rows[0]!.metadata,
      ).toMatchObject({ origin: 'manual_resume', sourceRunId: queued.id });
      expect((await read(f, task.id)).status).toBe('queued');
      const replay = await runtime.connect();
      try {
        await replay.query('BEGIN');
        expect(
          await writeNextAttempt(replay, {
            taskId: task.id,
            sourceRunId: queued.id,
            workspaceId: f.workspaceId,
            conversationId: f.conversationId,
            executionUserId: f.actorId,
            sourceAttempt: 1,
            plan: planManualResume({
              binding: {
                scope: { kind: 'personal', id: f.ownerId },
                connectionId: f.model.id,
                modelId: f.model.modelId,
              },
              sourceRunId: queued.id,
              chainRootRunId: queued.id,
              chainAttemptOrdinal: 2,
              chainLimitSnapshot: 4,
              now,
            }),
            now,
          }),
        ).toEqual({ scheduled: false, reason: 'duplicate' });
        await replay.query('COMMIT');
      } finally {
        replay.release();
      }
      expect(
        (await runtime.query('SELECT id FROM task_runs WHERE task_id=$1', [task.id])).rows,
      ).toHaveLength(2);
      expect(
        (
          await runtime.query(
            'SELECT id,attempt,status,finished_at,started_at,claim_token,error_code,output_event_id FROM task_runs WHERE id=$1',
            [queued.id],
          )
        ).rows[0],
      ).toEqual(interrupted);
    });

    it('rejects a forged queued-to-paused advance without its pause marker and checkpoint', async () => {
      const f = await fixture();
      const task = await submit(f);
      const queued = (
        await runtime.query<{ id: string }>(
          'SELECT id FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1',
          [task.id],
        )
      ).rows[0]!;
      const forged = await runtime.connect();
      try {
        await forged.query('BEGIN');
        await expect(
          forged.query("UPDATE task_runs SET status='paused',finished_at=NOW() WHERE id=$1", [
            queued.id,
          ]),
        ).rejects.toThrow(/command marker|immutable/u);
        await forged.query('ROLLBACK');
      } finally {
        forged.release();
      }
      expect(
        (await runtime.query('SELECT status FROM tasks WHERE id=$1', [task.id])).rows[0],
      ).toEqual({ status: 'queued' });
      expect(
        (await runtime.query('SELECT status FROM task_runs WHERE id=$1', [queued.id])).rows[0],
      ).toEqual({ status: 'queued' });
    });

    it('pauses a running Task under openbot_runtime, resumes through the service, and keeps the interrupted Run', async () => {
      const f = await fixture();
      const task = await submit(f);
      const queue = new TaskQueue(runtime);
      const claimed = await queue.claimNext();
      expect(claimed.claim?.taskId).toBe(task.id);
      await queue.publishDelta(claimed.claim!, 'Visible prefix 🌿');
      const interruptedBefore = (
        await runtime.query(
          'SELECT id,attempt,status,started_at,claim_token,deadline_at,connection_id,model_id,input_tokens,output_tokens FROM task_runs WHERE id=$1',
          [claimed.claim!.runId],
        )
      ).rows[0];
      const paused = await new TaskService(runtime).pause(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
        { idempotencyKey: 'native-running-pause', expectedRunId: claimed.claim!.runId },
      );
      expect(paused.task.status).toBe('paused');
      expect(paused.pause).toMatchObject({
        runId: claimed.claim!.runId,
        attempt: 1,
        affectedTaskCount: 1,
        affectedRunCount: 1,
      });
      expect(await queue.isClaimActive(claimed.claim!)).toBe(false);
      expect(await queue.finish(claimed.claim!, { body: 'Late answer', usage: null })).toBe(false);
      expect(await queue.claimNext()).toEqual({ handled: false });
      const interrupted = (
        await runtime.query(
          'SELECT id,attempt,status,started_at,claim_token,deadline_at,connection_id,model_id,input_tokens,output_tokens,error_code,output_event_id FROM task_runs WHERE id=$1',
          [claimed.claim!.runId],
        )
      ).rows[0];
      expect(interrupted).toMatchObject({
        ...interruptedBefore,
        status: 'paused',
        error_code: null,
        output_event_id: null,
      });
      expect(
        (
          await runtime.query(
            'SELECT strategy,schema_version,end_byte FROM task_run_pause_checkpoints WHERE run_id=$1',
            [claimed.claim!.runId],
          )
        ).rows,
      ).toEqual([
        {
          strategy: 'restart_from_task_input_v1',
          schema_version: 1,
          end_byte: Buffer.byteLength('Visible prefix 🌿'),
        },
      ]);
      expect(
        (
          await admin.query(
            "SELECT has_function_privilege('openbot_runtime',$1,'EXECUTE') AS allowed",
            ['lock_task_ancestry(uuid,boolean)'],
          )
        ).rows[0].allowed,
      ).toBe(true);
      const resumed = await new TaskService(runtime).resume(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
        { idempotencyKey: 'native-running-resume', expectedRunId: claimed.claim!.runId },
      );
      expect(resumed.task).toMatchObject({ id: task.id, status: 'queued', runCount: 2 });
      expect(resumed.resume).toMatchObject({
        sourceRunId: claimed.claim!.runId,
        attempt: 2,
        affectedTaskCount: 1,
        affectedRunCount: 1,
      });
      expect(resumed.resume.runId).not.toBe(claimed.claim!.runId);
      expect(
        (
          await runtime.query(
            'SELECT id,attempt,status,started_at,claim_token,deadline_at,connection_id,model_id,input_tokens,output_tokens,error_code,output_event_id FROM task_runs WHERE id=$1',
            [claimed.claim!.runId],
          )
        ).rows[0],
      ).toEqual(interrupted);
      expect(
        await new TaskService(runtime).resume(f.actorId, f.workspaceId, f.conversationId, task.id, {
          idempotencyKey: 'native-running-resume',
          expectedRunId: claimed.claim!.runId,
        }),
      ).toEqual(resumed);
      const noop = await new TaskService(runtime).resume(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        task.id,
        { idempotencyKey: 'already-resumed', expectedRunId: claimed.claim!.runId },
      );
      expect(noop.task).toEqual(resumed.task);
      expect(noop.resume).toMatchObject({
        runId: resumed.resume.runId,
        sourceRunId: claimed.claim!.runId,
        checkpointId: resumed.resume.checkpointId,
        resumedAt: resumed.resume.resumedAt,
        affectedTaskCount: 0,
        affectedRunCount: 0,
      });
      await expect(
        new TaskService(runtime).resume(f.actorId, f.workspaceId, f.conversationId, task.id, {
          idempotencyKey: 'stale-resume',
          expectedRunId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'task_resume_run_conflict' });
      expect(
        (await runtime.query('SELECT id FROM task_runs WHERE task_id=$1', [task.id])).rows,
      ).toHaveLength(2);
    });

    it('pauses a group subtree under openbot_runtime and resumes only the selected Task', async () => {
      const f = await fixture('workspace', true);
      const parent = await submit(f);
      const child = await createQueuedTaskChild(runtime, {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        executionUserId: f.actorId,
        botId: f.bot.id,
        botVersionId: f.bot.currentVersion!.id,
        groupGrantId: f.grant!.id,
        parentTaskId: parent.id,
      });
      const queue = new TaskQueue(runtime);
      const claims = new Map<string, TaskClaim>();
      for (let index = 0; index < 2; index++) {
        const next = await queue.claimNext();
        expect(next.claim).toBeDefined();
        claims.set(next.claim!.taskId, next.claim!);
      }
      expect(claims.has(parent.id)).toBe(true);
      expect(claims.has(child.id)).toBe(true);
      const paused = await new TaskService(runtime).pause(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        parent.id,
        { idempotencyKey: 'native-tree-pause', expectedRunId: claims.get(parent.id)!.runId },
      );
      expect(paused.pause).toMatchObject({ affectedTaskCount: 2, affectedRunCount: 2 });
      expect(await queue.isClaimActive(claims.get(parent.id)!)).toBe(false);
      expect(await queue.isClaimActive(claims.get(child.id)!)).toBe(false);
      expect(
        (
          await runtime.query('SELECT status FROM tasks WHERE id=$1 OR id=$2 ORDER BY id', [
            parent.id,
            child.id,
          ])
        ).rows.map((row) => row.status),
      ).toEqual(['paused', 'paused']);
      await expect(
        new TaskService(runtime).resume(f.ownerId, f.workspaceId, f.conversationId, parent.id, {
          idempotencyKey: 'admin-resume',
          expectedRunId: claims.get(parent.id)!.runId,
        }),
      ).rejects.toBeInstanceOf(TaskAccessError);
      await expect(
        new TaskService(runtime).resume(f.actorId, f.workspaceId, f.conversationId, child.id, {
          idempotencyKey: 'resume-child-first',
          expectedRunId: child.runId,
        }),
      ).rejects.toMatchObject({ code: 'task_resume_paused_ancestor' });
      const resumed = await new TaskService(runtime).resume(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        parent.id,
        { idempotencyKey: 'resume-root', expectedRunId: claims.get(parent.id)!.runId },
      );
      expect(resumed.task).toMatchObject({ id: parent.id, status: 'queued', runCount: 2 });
      expect(resumed.resume).toMatchObject({
        sourceRunId: claims.get(parent.id)!.runId,
        attempt: 2,
        affectedTaskCount: 1,
      });
      expect(
        (await runtime.query('SELECT status FROM tasks WHERE id=$1', [child.id])).rows,
      ).toEqual([{ status: 'paused' }]);
      const childResume = await new TaskService(runtime).resume(
        f.actorId,
        f.workspaceId,
        f.conversationId,
        child.id,
        { idempotencyKey: 'resume-child', expectedRunId: child.runId },
      );
      expect(childResume.task).toMatchObject({ id: child.id, status: 'queued', runCount: 2 });
      expect(childResume.resume).toMatchObject({ sourceRunId: child.runId, attempt: 2 });
    });

    it('recovers an expired native claim once through the shared writer and fences the old token', async () => {
      const f = await fixture();
      const queue = new TaskQueue(runtime);
      const task = await submit(f);
      const claimed = await queue.claimNext();
      expect(claimed.claim).toBeDefined();
      const claim = claimed.claim!;
      expect(
        (
          await runtime.query('SELECT claim_token FROM task_run_leases WHERE run_id=$1', [
            claim.runId,
          ])
        ).rows,
      ).toEqual([{ claim_token: claim.claimToken }]);
      await runtime.query('UPDATE task_run_leases SET expires_at=heartbeat_at WHERE run_id=$1', [
        claim.runId,
      ]);
      expect(
        await queue.finish(claim, {
          body: 'This late completion must not be published.',
          usage: { inputTokens: 2, outputTokens: 2 },
        }),
      ).toBe(false);
      expect(await queue.recoverExpiredClaims()).toBe(1);
      const runs = (
        await runtime.query(
          'SELECT id,attempt,status,error_code,claim_token FROM task_runs WHERE task_id=$1 ORDER BY attempt',
          [task.id],
        )
      ).rows;
      expect(runs).toMatchObject([
        {
          id: claim.runId,
          attempt: 1,
          status: 'failed',
          error_code: 'worker_interrupted',
          claim_token: claim.claimToken,
        },
        { attempt: 2, status: 'queued', error_code: null, claim_token: null },
      ]);
      expect(
        (
          await runtime.query(
            'SELECT decision,successor_run_id,stop_reason FROM task_run_recovery_receipts WHERE source_run_id=$1',
            [claim.runId],
          )
        ).rows,
      ).toEqual([
        { decision: 'queued_successor', successor_run_id: runs[1]!.id, stop_reason: null },
      ]);
      expect(
        (
          await runtime.query('SELECT task_queued_audit_metadata($1::uuid) AS metadata', [
            runs[1]!.id,
          ])
        ).rows[0]!.metadata,
      ).toMatchObject({ origin: 'worker_recovery', sourceRunId: claim.runId });
      expect(await queue.recoverExpiredClaims()).toBe(0);
      expect(
        await queue.finish(claim, {
          body: 'Still late.',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ).toBe(false);
      expect(
        (await runtime.query('SELECT status,error_code FROM task_runs WHERE id=$1', [claim.runId]))
          .rows,
      ).toEqual([{ status: 'failed', error_code: 'worker_interrupted' }]);
    });

    it('lets only one of two workers recover an expired lease and commit the successor', async () => {
      const f = await fixture();
      const queue = new TaskQueue(runtime);
      const task = await submit(f);
      const claim = (await queue.claimNext()).claim!;
      await runtime.query('UPDATE task_run_leases SET expires_at=heartbeat_at WHERE run_id=$1', [
        claim.runId,
      ]);
      const recovered = await contenders(f, (pool) => new TaskQueue(pool).recoverExpiredClaims());
      expect(recovered.sort()).toEqual([0, 1]);
      const runs = (
        await runtime.query(
          'SELECT id,attempt,status,error_code FROM task_runs WHERE task_id=$1 ORDER BY attempt',
          [task.id],
        )
      ).rows;
      expect(runs).toMatchObject([
        { id: claim.runId, attempt: 1, status: 'failed', error_code: 'worker_interrupted' },
        { attempt: 2, status: 'queued', error_code: null },
      ]);
      expect(
        (
          await runtime.query(
            'SELECT decision,successor_run_id FROM task_run_recovery_receipts WHERE source_run_id=$1',
            [claim.runId],
          )
        ).rows,
      ).toEqual([{ decision: 'queued_successor', successor_run_id: runs[1]!.id }]);
      expect(
        await queue.finish(claim, {
          body: 'Late result after a raced recovery.',
          usage: { inputTokens: 2, outputTokens: 2 },
        }),
      ).toBe(false);
      const selected = await contenders(f, (pool) => new TaskQueue(pool).claimNext());
      const admitted = selected.flatMap((result) => (result.claim ? [result.claim] : []));
      expect(admitted).toHaveLength(1);
      expect(admitted[0]!.runId).toBe(runs[1]!.id);
      const completed = await contenders(f, (pool) =>
        new TaskQueue(pool).finish(admitted[0]!, {
          body: 'One recovered answer.',
          usage: { inputTokens: 3, outputTokens: 4 },
        }),
      );
      expect(completed.sort()).toEqual([false, true]);
      expect(
        (
          await runtime.query(
            "SELECT id FROM conversation_events WHERE conversation_id=$1 AND event_type='bot.message.created'",
            [f.conversationId],
          )
        ).rows,
      ).toHaveLength(1);
      expect(await read(f, task.id)).toMatchObject({
        status: 'completed',
        runCount: 2,
        runs: [{ id: admitted[0]!.runId, attempt: 2, status: 'completed', error: null }],
      });
    }, 15000);

    it('grants one selected duration cap and resumes waiting_budget without rewriting the snapshot', async () => {
      let current = new Date('2026-09-06T06:00:00.000Z');
      const f = await fixture('personal', false, {
        retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
      });
      await admin.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
        f.workspaceId,
        JSON.stringify({ maxDurationSeconds: 1 }),
      ]);
      const task = await submit(f, runtime, 'budget-task', 'Stay inside the snapshotted cap.');
      const queue = new TaskQueue(runtime, () => current);
      const { claim } = await queue.claimNext();
      expect(claim).toBeDefined();
      expect(claim!.deadlineAt.getTime() - current.getTime()).toBe(1_000);
      await queue.publishDelta(claim!, 'Partial draft.');
      current = new Date(claim!.deadlineAt.getTime() + 1);
      expect(
        await queue.finish(claim!, {
          body: 'Too late to complete.',
          usage: { inputTokens: 2, outputTokens: 1 },
        }),
      ).toBe(true);
      expect(await read(f, task.id)).toMatchObject({
        status: 'failed',
        runCount: 1,
        runs: [{ status: 'failed', error: 'execution_timeout', output: null }],
      });
      const holdConnection = await runtime.connect();
      try {
        await holdConnection.query('BEGIN');
        const binding = {
          scope: { kind: 'personal' as const, id: f.ownerId },
          connectionId: f.model.id,
          modelId: f.model.modelId,
        };
        expect(
          await writeNextAttempt(holdConnection, {
            taskId: task.id,
            sourceRunId: claim!.runId,
            workspaceId: f.workspaceId,
            conversationId: f.conversationId,
            executionUserId: f.ownerId,
            sourceAttempt: 1,
            plan: {
              origin: 'provider_retry',
              reason: 'provider_rate_limited',
              binding,
              previousBinding: binding,
              notBefore: current,
              delayMs: 0,
              jitterMs: 0,
              chainRootRunId: claim!.runId,
              previousRunId: claim!.runId,
              chainAttemptOrdinal: 2,
              chainLimitSnapshot: 4,
              modelAttemptOrdinal: 1,
            },
            now: current,
          }),
        ).toEqual({ scheduled: false, reason: 'budget' });
        await holdConnection.query('COMMIT');
      } finally {
        holdConnection.release();
      }
      expect(await read(f, task.id)).toMatchObject({
        status: 'waiting_budget',
        runCount: 1,
        runs: [{ status: 'failed', error: 'execution_timeout', output: null }],
      });
      expect(
        (
          await runtime.query('SELECT body FROM task_run_partial_outputs WHERE run_id=$1', [
            claim!.runId,
          ])
        ).rows[0],
      ).toEqual({ body: 'Partial draft.' });
      const snapshot = (
        await runtime.query<{ max_duration_ms: string }>(
          'SELECT max_duration_ms FROM task_execution_limit_snapshots WHERE task_id=$1',
          [task.id],
        )
      ).rows[0]!;
      expect(Number(snapshot.max_duration_ms)).toBe(1_000);
      await expect(
        new TaskService(runtime).grantLimit(f.memberId, f.workspaceId, f.conversationId, task.id, {
          idempotencyKey: 'raise-duration',
          dimension: 'duration',
          limit: 5_000,
        }),
      ).rejects.toBeInstanceOf(TaskAccessError);
      const granted = await new TaskService(runtime).grantLimit(
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        task.id,
        {
          idempotencyKey: 'raise-duration',
          dimension: 'duration',
          limit: 5_000,
        },
      );
      expect(granted.task.status).toBe('queued');
      expect(granted.grant).toMatchObject({
        dimension: 'duration',
        previousLimit: 1_000,
        grantedLimit: 5_000,
        attempt: 2,
      });
      expect(
        Number(
          (
            await runtime.query<{ max_duration_ms: string }>(
              'SELECT max_duration_ms FROM task_execution_limit_snapshots WHERE task_id=$1',
              [task.id],
            )
          ).rows[0]!.max_duration_ms,
        ),
      ).toBe(1_000);
      const replay = await new TaskService(runtime).grantLimit(
        f.ownerId,
        f.workspaceId,
        f.conversationId,
        task.id,
        {
          idempotencyKey: 'raise-duration',
          dimension: 'duration',
          limit: 5_000,
        },
      );
      expect(replay.grant.grantId).toBe(granted.grant.grantId);
      expect(replay.grant.runId).toBe(granted.grant.runId);
    }, 15000);
  },
);

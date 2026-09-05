import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import {
  ConversationTransaction,
  PostgresConversationRepository,
} from '../../src/conversations/postgres-repository.js';
import { ConversationService } from '../../src/conversations/service.js';
import {
  appendQueuedRunState,
  appendRunningRunState,
  appendFailedRunState,
  appendCancelledRunState,
  appendAssistantDelta,
} from '../../src/conversations/append-event.js';
import { reclaimConversationStream } from '../../src/conversations/stream-retention.js';
import {
  STREAM_LIMITS,
  encodeConversationStreamEvent,
} from '../../src/conversations/stream-protocol.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupBotService, type GroupBotGrant } from '../../src/group-bots/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { TaskQueue, type TaskClaim } from '../../src/tasks/queue.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { taskSubmissionHash } from '../../src/tasks/submission-admission.js';
import { cancelTask as cancelInTransaction } from '../../src/tasks/cancellation.js';
import { createQueuedTaskChild } from '../helpers/task-tree-fixture.js';

// Dedicated disposable database: this file installs real 0022, exercises the
// drain preflight, then installs actual 0023 and provisions its narrow runtime
// role. The 0023 cases bootstrap that schema themselves so they do not lag
// Compose or depend on the drain test succeeding.
const databaseUrl = process.env.TEST_TASK_CANCELLATION_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'Task cancellation with deployed PostgreSQL guards',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let runtime = admin;
    const workspaces: string[] = [];
    beforeAll(async () => {
      await migrateDatabase(admin, { throughVersion: '0022_failed_task_retries' });
    });
    afterEach(async () => {
      const ids = workspaces.splice(0);
      if (!ids.length) return;
      const connection = await admin.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          "UPDATE task_runs SET status='failed',finished_at=NOW(),error_code='worker_stopped' WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id=ANY($1::uuid[])) AND status IN ('queued','running')",
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
      if (runtime !== admin) await runtime.end();
      await admin.end();
    });
    async function provisionRuntime() {
      const url = new URL(databaseUrl!),
        password = `ci-cancel-${randomBytes(24).toString('hex')}`;
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
    }
    async function ensureDeployedCancellationSchema() {
      await migrateDatabase(admin);
      const versions = (
        await admin.query('SELECT version FROM openbot_schema_migrations')
      ).rows.map((row) => row.version);
      if (!versions.includes('0023_task_tree_cancellation'))
        throw new Error('Cancellation suite requires deployed migration 0023');
      if (runtime === admin) await provisionRuntime();
    }
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
    const cancel = (
      f: Fixture,
      taskId: string,
      runId: string,
      key = 'cancel',
      pool = runtime,
      actor = f.actorId,
    ) =>
      new TaskService(pool).cancel(actor, f.workspaceId, f.conversationId, taskId, {
        idempotencyKey: key,
        expectedRunId: runId,
      });
    const child = (f: Fixture, parentTaskId: string) =>
      createQueuedTaskChild(runtime, {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        executionUserId: f.actorId,
        botId: f.bot.id,
        botVersionId: f.bot.currentVersion!.id,
        groupGrantId: f.grant!.id,
        parentTaskId,
      });
    async function transaction<T>(
      action: (connection: pg.PoolClient) => Promise<T>,
      pool = runtime,
    ) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await action(connection);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
    async function snapshot(f: Fixture) {
      return (
        await admin.query(
          `SELECT
      (SELECT to_jsonb(c) FROM conversations c WHERE id=$1) AS conversation,
      (SELECT jsonb_agg(e ORDER BY e.sequence) FROM conversation_events e WHERE conversation_id=$1) AS events,
      (SELECT jsonb_agg(t ORDER BY t.id) FROM tasks t WHERE conversation_id=$1) AS tasks,
      (SELECT jsonb_agg(r ORDER BY r.id) FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=$1) AS runs,
      (SELECT jsonb_agg(a ORDER BY a.id) FROM audit_events a WHERE metadata->>'conversationId'=$1::text) AS audits,
      (SELECT jsonb_agg(c ORDER BY c.id) FROM task_cancel_commands c JOIN tasks t ON t.id=c.task_id WHERE t.conversation_id=$1) AS commands,
      (SELECT jsonb_agg(c ORDER BY c.run_id) FROM task_run_cancellations c JOIN task_runs r ON r.id=c.run_id JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=$1) AS markers,
      (SELECT jsonb_agg(p ORDER BY p.run_id) FROM task_run_partial_outputs p JOIN task_runs r ON r.id=p.run_id JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=$1) AS partials,
      (SELECT jsonb_agg(p ORDER BY p.run_id) FROM task_run_streams p JOIN task_runs r ON r.id=p.run_id JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=$1) AS progress,
      (SELECT jsonb_agg(d ORDER BY d.sequence) FROM conversation_delivery_events d WHERE d.conversation_id=$1) AS delivery,
      (SELECT jsonb_agg(r ORDER BY r.sequence) FROM task_run_delivery_receipts r WHERE r.conversation_id=$1) AS receipts`,
          [f.conversationId],
        )
      ).rows[0];
    }
    // Same contiguous allocation/feed/progress/checkpoint/retention transaction as
    // the typed appender, but no JS body-length guard: the deployed DB must decide.
    async function rawCheckpointDelta(f: Fixture, claim: TaskClaim, text: string) {
      await transaction(async (connection) => {
        await ConversationTransaction.lock(connection, {
          actorUserId: f.actorId,
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
        });
        await connection.query('SELECT lock_task_ancestry($1)', [claim.taskId]);
        const retained = (
          await connection.query<{ attempt: number }>(
            'SELECT attempt FROM task_runs WHERE id=$1 FOR UPDATE',
            [claim.runId],
          )
        ).rows[0]!;
        await connection.query(
          'INSERT INTO task_run_streams(run_id) VALUES($1) ON CONFLICT(run_id) DO NOTHING',
          [claim.runId],
        );
        const previous = (
          await connection.query<{ body: string; end_byte: number }>(
            'SELECT body,end_byte FROM task_run_partial_outputs WHERE run_id=$1',
            [claim.runId],
          )
        ).rows[0];
        const startByte = previous?.end_byte ?? 0,
          endByte = startByte + Buffer.byteLength(text),
          body = (previous?.body ?? '') + text,
          occurredAt = new Date(),
          sequence = Number(
            (
              await connection.query(
                'UPDATE conversations SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING last_sequence',
                [f.conversationId],
              )
            ).rows[0].last_sequence,
          );
        encodeConversationStreamEvent(
          { workspaceId: f.workspaceId, conversationId: f.conversationId },
          sequence,
          occurredAt,
          {
            type: 'assistant.delta',
            data: {
              taskId: claim.taskId,
              runId: claim.runId,
              attempt: retained.attempt,
              startByte,
              endByte,
              text,
            },
          },
        );
        await connection.query(
          "INSERT INTO conversation_delivery_events(conversation_id,sequence,occurred_at,event_type,run_id,delta_text,start_byte,end_byte,byte_size) VALUES($1,$2,$3,'assistant.delta',$4,$5,$6,$7,$8)",
          [
            f.conversationId,
            sequence,
            occurredAt,
            claim.runId,
            text,
            startByte,
            endByte,
            2048 + 6 * Buffer.byteLength(text),
          ],
        );
        await connection.query('UPDATE task_run_streams SET delivered_bytes=$2 WHERE run_id=$1', [
          claim.runId,
          endByte,
        ]);
        await connection.query(
          previous
            ? 'UPDATE task_run_partial_outputs SET body=$2,end_byte=$3,updated_at=$4 WHERE run_id=$1'
            : 'INSERT INTO task_run_partial_outputs(run_id,body,end_byte,updated_at) VALUES($1,$2,$3,$4)',
          [claim.runId, body, endByte, occurredAt],
        );
        await reclaimConversationStream(connection, f.conversationId, occurredAt);
      });
    }
    function observedPool() {
      const name = `cancel-${randomUUID()}`;
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
          const found = await admin.query(
            `WITH RECURSIVE chain(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
        UNION SELECT unnest(pg_blocking_pids(chain.pid)) FROM chain
      ) SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
        AND EXISTS(SELECT 1 FROM chain WHERE pid=$2)`,
            [name, blockerPid],
          );
          expect(found.rows).toHaveLength(1);
        },
        { timeout: 5000, interval: 20 },
      );
    }
    async function claimAll() {
      const queue = new TaskQueue(runtime),
        claims = new Map<string, TaskClaim>();
      for (;;) {
        const result = await queue.claimNext();
        if (!result.handled) break;
        if (result.claim) claims.set(result.claim.taskId, result.claim);
      }
      return claims;
    }
    async function rejectAudit(type: string, action: () => Promise<unknown>) {
      const name = `reject_cancel_audit_${randomBytes(8).toString('hex')}`;
      await admin.query(
        `CREATE FUNCTION ${name}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type=TG_ARGV[0] THEN RAISE EXCEPTION 'forced cancellation audit failure'; END IF; RETURN NEW; END; $$`,
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
    async function legacyTask(f: Fixture, key: string) {
      return transaction(async (connection) => {
        const conversation = await ConversationTransaction.lock(connection, {
          actorUserId: f.actorId,
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
        });
        const id = randomUUID(),
          runId = randomUUID(),
          body = 'Legacy human request ' + key,
          now = new Date();
        const trigger = await conversation.appendTaskTrigger({
          idempotencyKey: key,
          body,
          groupGrantId: f.grant!.id,
        });
        await connection.query(
          "INSERT INTO tasks(id,workspace_id,conversation_id,bot_id,bot_version_id,execution_user_id,trigger_event_id,command_hash,status,created_at,group_grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10)",
          [
            id,
            f.workspaceId,
            f.conversationId,
            f.bot.id,
            f.bot.currentVersion!.id,
            f.actorId,
            trigger.receipt.eventId,
            taskSubmissionHash(body, f.grant!.id),
            now,
            f.grant!.id,
          ],
        );
        await connection.query(
          "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,1,'queued',$3)",
          [runId, id, now],
        );
        await connection.query(
          "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.queued',$2,$3,$4::jsonb)",
          [
            randomUUID(),
            f.actorId,
            now,
            JSON.stringify({
              workspaceId: f.workspaceId,
              conversationId: f.conversationId,
              taskId: id,
              runId,
              attempt: 1,
            }),
          ],
        );
        await appendQueuedRunState(connection, runId, () => new Date());
        return { id, runId };
      }, admin);
    }

    it('checks actual legacy constraint names, refuses a running upgrade atomically and preserves queued roots after an explicit drain', async () => {
      const checkNames = async () =>
        (
          await admin.query(
            "SELECT conrelid::regclass::text AS relation,conname FROM pg_constraint WHERE contype='c' AND conrelid IN ('tasks'::regclass,'task_runs'::regclass,'conversation_delivery_events'::regclass,'task_run_delivery_receipts'::regclass) ORDER BY conname",
          )
        ).rows;
      const beforeChecks = await checkNames();
      expect(beforeChecks).toEqual(
        expect.arrayContaining([
          { relation: 'tasks', conname: 'tasks_status_check' },
          { relation: 'task_runs', conname: 'task_runs_status_check' },
          { relation: 'task_runs', conname: 'task_runs_check2' },
          {
            relation: 'conversation_delivery_events',
            conname: 'conversation_delivery_events_run_status_check',
          },
          {
            relation: 'task_run_delivery_receipts',
            conname: 'task_run_delivery_receipts_run_status_check',
          },
        ]),
      );
      const f = await fixture('workspace', true),
        queued = await legacyTask(f, 'queued-upgrade'),
        running = await legacyTask(f, 'running-upgrade');
      await transaction(async (connection) => {
        await ConversationTransaction.lock(connection, {
          actorUserId: f.actorId,
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
        });
        const started = new Date(),
          deadline = new Date(started.getTime() + 60_000);
        const revision = (
          await connection.query('SELECT revision FROM workspace_model_connections WHERE id=$1', [
            f.model.id,
          ])
        ).rows[0].revision;
        await connection.query(
          "UPDATE task_runs SET status='running',claim_token=$2,started_at=$3,deadline_at=$4,provider_scope_kind='workspace',provider_scope_id=$5,connection_id=$6,connection_revision=$7,protocol='openai-responses',model_id=$8 WHERE id=$1",
          [
            running.runId,
            randomUUID(),
            started,
            deadline,
            f.workspaceId,
            f.model.id,
            revision,
            f.model.modelId,
          ],
        );
        await connection.query("UPDATE tasks SET status='running' WHERE id=$1", [running.id]);
        await appendRunningRunState(connection, running.runId, () => new Date());
      }, admin);
      const beforeRuns = (
        await admin.query('SELECT * FROM task_runs WHERE task_id=$1 OR task_id=$2 ORDER BY id', [
          queued.id,
          running.id,
        ])
      ).rows;
      await expect(migrateDatabase(admin)).rejects.toMatchObject({
        code: '55000',
        message: expect.stringContaining('drain legacy workers'),
      });
      expect(await checkNames()).toEqual(beforeChecks);
      expect(
        (
          await admin.query(
            "SELECT version FROM openbot_schema_migrations WHERE version LIKE '0023_%'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='root_task_id'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query('SELECT * FROM task_runs WHERE task_id=$1 OR task_id=$2 ORDER BY id', [
            queued.id,
            running.id,
          ])
        ).rows,
      ).toEqual(beforeRuns);
      await transaction(async (connection) => {
        await connection.query(
          "UPDATE task_runs SET status='failed',finished_at=NOW(),error_code='worker_stopped' WHERE id=$1",
          [running.runId],
        );
        await connection.query("UPDATE tasks SET status='failed' WHERE id=$1", [running.id]);
        await appendFailedRunState(connection, running.runId, () => new Date());
      }, admin);
      const drained = (await admin.query('SELECT * FROM task_runs WHERE id=$1', [running.runId]))
        .rows;
      await migrateDatabase(admin);
      expect(
        (
          await admin.query(
            'SELECT version FROM openbot_schema_migrations ORDER BY version DESC LIMIT 2',
          )
        ).rows.map((r) => r.version),
      ).toEqual(['0023_task_tree_cancellation', '0022_failed_task_retries']);
      expect(
        (
          await admin.query(
            'SELECT id,root_task_id,parent_task_id,depth,status FROM tasks WHERE id=$1 OR id=$2 ORDER BY id',
            [queued.id, running.id],
          )
        ).rows,
      ).toEqual(
        expect.arrayContaining([
          {
            id: queued.id,
            root_task_id: queued.id,
            parent_task_id: null,
            depth: 0,
            status: 'queued',
          },
          {
            id: running.id,
            root_task_id: running.id,
            parent_task_id: null,
            depth: 0,
            status: 'failed',
          },
        ]),
      );
      expect(
        (await admin.query('SELECT * FROM task_runs WHERE id=$1', [running.runId])).rows,
      ).toEqual(drained);
      const removed = new Set([
        'tasks_status_check',
        'task_runs_status_check',
        'task_runs_check2',
        'conversation_delivery_events_run_status_check',
        'task_run_delivery_receipts_run_status_check',
      ]);
      expect(await checkNames()).toEqual(
        expect.arrayContaining(beforeChecks.filter((row) => !removed.has(row.conname))),
      );
      await provisionRuntime();
      expect((await cancel(f, queued.id, queued.runId)).task.status).toBe('cancelled');
      expect((await new TaskQueue(runtime).claimNext()).handled).toBe(false);
    }, 30000);

    describe('deployed 0023 cancellation schema', () => {
      beforeAll(async () => {
        await ensureDeployedCancellationSchema();
      });

      it('rejects a forged queued claim even inside a valid cancellation receipt, marker, audit and delivery transaction', async () => {
        const f = await fixture('workspace', true),
          task = await submit(f),
          runId = task.runs[0]!.id,
          before = await snapshot(f);
        const attempt = () =>
          transaction(async (connection) => {
            await ConversationTransaction.lock(
              connection,
              {
                actorUserId: f.actorId,
                workspaceId: f.workspaceId,
                conversationId: f.conversationId,
              },
              () => new Date(),
              'inspect',
            );
            const commandId = randomUUID(),
              now = new Date(),
              revision = (
                await connection.query(
                  'SELECT revision FROM workspace_model_connections WHERE id=$1',
                  [f.model.id],
                )
              ).rows[0].revision;
            await connection.query(
              'INSERT INTO task_cancel_commands(id,task_id,root_task_id,actor_user_id,idempotency_key,expected_run_id,attempt,cancelled_at,affected_task_count,affected_run_count,created_at) VALUES($1,$2,$2,$3,$4,$5,1,$6,1,1,$6)',
              [commandId, task.id, f.actorId, 'forged-queued-claim', runId, now],
            );
            await connection.query(
              "INSERT INTO task_run_cancellations(run_id,command_id,previous_status,cancelled_at) VALUES($1,$2,'queued',$3)",
              [runId, commandId, now],
            );
            // Everything except the invented start/claim/provider tuple is the legal
            // transaction. A marker alone must never let a queued Run look started.
            await connection.query(
              "UPDATE task_runs SET status='cancelled',finished_at=$2,started_at=$2,claim_token=$3,deadline_at=$4,provider_scope_kind='workspace',provider_scope_id=$5,connection_id=$6,connection_revision=$7,protocol='openai-responses',model_id=$8 WHERE id=$1",
              [
                runId,
                now,
                randomUUID(),
                new Date(now.getTime() + 60_000),
                f.workspaceId,
                f.model.id,
                revision,
                f.model.modelId,
              ],
            );
            await connection.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [task.id]);
            await connection.query(
              "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.cancelled',$2,$3,$4::jsonb)",
              [
                randomUUID(),
                f.actorId,
                now,
                JSON.stringify({
                  workspaceId: f.workspaceId,
                  conversationId: f.conversationId,
                  taskId: task.id,
                  runId,
                  attempt: 1,
                  cancelCommandId: commandId,
                  requestedTaskId: task.id,
                  rootTaskId: task.id,
                }),
              ],
            );
            await appendCancelledRunState(connection, runId, () => now);
          });
        await expect(attempt()).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('retained claim'),
        });
        expect(await snapshot(f)).toEqual(before);
      });

      it('cancels queued work with every original claim and provider field still NULL and creates no provider call', async () => {
        const f = await fixture(),
          task = await submit(f),
          runId = task.runs[0]!.id;
        const before = (await admin.query('SELECT * FROM task_runs WHERE id=$1', [runId])).rows[0];
        const result = await cancel(f, task.id, runId);
        expect(result.receipt).toMatchObject({ affectedTaskCount: 1, affectedRunCount: 1 });
        const after = (await admin.query('SELECT * FROM task_runs WHERE id=$1', [runId])).rows[0];
        expect(after).toEqual({
          ...before,
          status: 'cancelled',
          finished_at: result.receipt.cancelledAt,
        });
        expect(after.started_at).toBeNull();
        expect((await new TaskQueue(runtime).claimNext()).handled).toBe(false);
        expect(result.task.runs[0]).toMatchObject({
          startedAt: null,
          provider: null,
          usage: null,
          output: null,
          error: null,
        });
      });
      it('keeps exact replay immutable and gives each new key a stable zero-effect receipt without a second transition', async () => {
        const f = await fixture(),
          task = await submit(f),
          runId = task.runs[0]!.id;
        const first = await cancel(f, task.id, runId),
          saved = await snapshot(f);
        expect(await cancel(f, task.id, runId)).toEqual(first);
        expect(await snapshot(f)).toEqual(saved);
        const next = await cancel(f, task.id, runId, 'another-command');
        expect(next.receipt).toMatchObject({
          taskId: task.id,
          runId,
          cancelledAt: first.receipt.cancelledAt,
          affectedTaskCount: 0,
          affectedRunCount: 0,
        });
        expect(next.receipt.commandId).not.toBe(first.receipt.commandId);
        expect(await cancel(f, task.id, runId, 'another-command')).toEqual(next);
        const after = await snapshot(f);
        expect(after.commands).toHaveLength(2);
        expect({ ...after, commands: saved.commands }).toEqual(saved);
        await expect(cancel(f, task.id, randomUUID())).rejects.toMatchObject({
          code: 'idempotency_conflict',
        });
        expect(await snapshot(f)).toEqual(after);
      });

      it('retains full UTF-8 output after feed reclamation and rejects late delta, finish and raw partial mutation', async () => {
        const f = await fixture(),
          task = await submit(f),
          queue = new TaskQueue(runtime),
          claim = (await queue.claimNext()).claim!;
        const prefix = 'First 🌿\nThen 漢字';
        await queue.publishDelta(claim, 'First 🌿\n');
        await queue.publishDelta(claim, 'Then 漢字');
        await cancel(f, task.id, claim.runId);
        const before = await snapshot(f);
        await expect(queue.publishDelta(claim, 'Late suffix')).rejects.toMatchObject({
          code: 'worker_stopped',
        });
        expect(
          await queue.finish(claim, {
            body: 'Late final',
            usage: { inputTokens: 1, outputTokens: 2 },
          }),
        ).toBe(false);
        expect(await queue.isClaimActive(claim)).toBe(false);
        await expect(
          runtime.query("UPDATE task_run_partial_outputs SET body='corrupt' WHERE run_id=$1", [
            claim.runId,
          ]),
        ).rejects.toMatchObject({ code: '55000' });
        await expect(
          runtime.query('DELETE FROM task_run_partial_outputs WHERE run_id=$1', [claim.runId]),
        ).rejects.toMatchObject({ code: '55000' });
        expect(await snapshot(f)).toEqual(before);
        await transaction(async (connection) => {
          await connection.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
            f.conversationId,
          ]);
          await reclaimConversationStream(
            connection,
            f.conversationId,
            new Date(Date.now() + STREAM_LIMITS.retentionMs + 1000),
          );
        });
        expect(
          (
            await admin.query(
              'SELECT sequence FROM conversation_delivery_events WHERE conversation_id=$1',
              [f.conversationId],
            )
          ).rows,
        ).toEqual([]);
        const rebuilt = observedPool();
        try {
          expect(
            await new TaskService(rebuilt.pool).partialOutput(
              f.actorId,
              f.workspaceId,
              f.conversationId,
              task.id,
              claim.runId,
            ),
          ).toEqual({
            conversationId: f.conversationId,
            taskId: task.id,
            runId: claim.runId,
            partial: { text: prefix, endByte: Buffer.byteLength(prefix), interrupted: true },
          });
          expect((await read(f, task.id, rebuilt.pool)).runs[0]).toMatchObject({
            status: 'cancelled',
            output: null,
          });
        } finally {
          await rebuilt.pool.end();
        }
      });

      it.each([
        { kind: 'astral', character: '🌱', count: 16000 },
        { kind: 'BMP', character: '界', count: 32000 },
      ])(
        'retains the exact $kind UTF-16 boundary and rolls back a complete raw delta transaction one character beyond it',
        async ({ character, count }) => {
          const f = await fixture(),
            task = await submit(f),
            claim = (await new TaskQueue(runtime).claimNext()).claim!;
          for (let index = 0; index < count; index += 1000)
            await rawCheckpointDelta(f, claim, character.repeat(1000));
          const body = character.repeat(count),
            before = await snapshot(f);
          expect(body.length).toBe(32000);
          expect(before.partials[0]).toMatchObject({ body, end_byte: Buffer.byteLength(body) });
          await expect(rawCheckpointDelta(f, claim, character)).rejects.toMatchObject({
            code: '23514',
            message: 'Run partial exceeds 32000 UTF-16 code units',
          });
          expect(await snapshot(f)).toEqual(before);
          await cancel(f, task.id, claim.runId);
          expect(
            await new TaskService(runtime).partialOutput(
              f.actorId,
              f.workspaceId,
              f.conversationId,
              task.id,
              claim.runId,
            ),
          ).toMatchObject({
            partial: { text: body, endByte: Buffer.byteLength(body), interrupted: true },
          });
        },
      );

      it('cancels all unfinished descendants through terminal intermediates and preserves terminal history and unrelated roots', async () => {
        const f = await fixture('workspace', true),
          root = await submit(f),
          middle = await child(f, root.id),
          leaf = await child(f, middle.id),
          failed = await child(f, root.id),
          unrelated = await submit(f, runtime, 'unrelated');
        const claims = await claimAll(),
          queue = new TaskQueue(runtime);
        await queue.finish(claims.get(middle.id)!, { body: 'Completed middle', usage: null });
        await queue.finish(claims.get(failed.id)!, { error: 'provider_failed', usage: null });
        await queue.publishDelta(claims.get(leaf.id)!, 'Saved child 🌱');
        const terminal = (
          await admin.query('SELECT * FROM task_runs WHERE task_id=ANY($1::uuid[]) ORDER BY id', [
            [middle.id, failed.id],
          ])
        ).rows;
        const result = await cancel(
          f,
          root.id,
          root.runs[0]!.id,
          'root-cancel',
          runtime,
          f.ownerId,
        );
        expect(result.receipt).toMatchObject({ affectedTaskCount: 2, affectedRunCount: 2 });
        expect(
          (
            await admin.query('SELECT * FROM task_runs WHERE task_id=ANY($1::uuid[]) ORDER BY id', [
              [middle.id, failed.id],
            ])
          ).rows,
        ).toEqual(terminal);
        expect(await queue.isClaimActive(claims.get(unrelated.id)!)).toBe(true);
        expect(await queue.isClaimActive(claims.get(leaf.id)!)).toBe(false);
        expect(
          await new TaskService(runtime).partialOutput(
            f.actorId,
            f.workspaceId,
            f.conversationId,
            leaf.id,
            leaf.runId,
          ),
        ).toMatchObject({ partial: { text: 'Saved child 🌱', interrupted: true } });
        expect(
          (
            await admin.query(
              "SELECT actor_user_id,metadata->>'runId' AS run_id FROM audit_events WHERE event_type='task.cancelled' AND metadata->>'conversationId'=$1",
              [f.conversationId],
            )
          ).rows,
        ).toEqual(
          expect.arrayContaining([
            { actor_user_id: f.ownerId, run_id: root.runs[0]!.id },
            { actor_user_id: f.ownerId, run_id: leaf.runId },
          ]),
        );
        await expect(child(f, middle.id)).rejects.toMatchObject({ code: '23514' });
        await expect(
          new TaskService(runtime).retry(f.actorId, f.workspaceId, f.conversationId, failed.id, {
            idempotencyKey: 'after-cancel',
            expectedRunId: failed.runId,
          }),
        ).rejects.toMatchObject({ code: 'task_retry_cancelled_ancestor' });
      }, 15000);

      it('rolls back every subtree state, marker, receipt, audit and existing partial when the cancellation audit fails', async () => {
        const f = await fixture('workspace', true),
          root = await submit(f),
          leaf = await child(f, root.id),
          claims = await claimAll();
        await new TaskQueue(runtime).publishDelta(claims.get(leaf.id)!, 'Before rollback 🌿');
        const before = await snapshot(f);
        await rejectAudit('task.cancelled', () => cancel(f, root.id, root.runs[0]!.id));
        expect(await snapshot(f)).toEqual(before);
        expect((await cancel(f, root.id, root.runs[0]!.id)).receipt.affectedRunCount).toBe(2);
      });

      it.each(['ancestor', 'descendant'] as const)(
        'serializes overlapping subtree commands with the %s cancellation committed first',
        async (firstScope) => {
          const f = await fixture('workspace', true),
            root = await submit(f),
            middle = await child(f, root.id),
            leaf = await child(f, middle.id),
            rootTarget = { id: root.id, runId: root.runs[0]!.id },
            first = firstScope === 'ancestor' ? rootTarget : middle,
            second = firstScope === 'ancestor' ? middle : rootTarget,
            holder = await runtime.connect(),
            observer = observedPool();
          let pending:
            Promise<PromiseSettledResult<Awaited<ReturnType<typeof cancel>>>[]> | undefined;
          try {
            await holder.query('BEGIN');
            const committedFirst = await cancelInTransaction(
              holder,
              {
                actorUserId: f.actorId,
                workspaceId: f.workspaceId,
                conversationId: f.conversationId,
              },
              first.id,
              { idempotencyKey: 'overlap-first', expectedRunId: first.runId },
              () => new Date(),
            );
            const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            pending = Promise.allSettled([
              cancel(f, second.id, second.runId, 'overlap-second', observer.pool),
            ]);
            await blocked(observer.name, pid);
            expect(
              (
                await admin.query('SELECT status FROM tasks WHERE conversation_id=$1', [
                  f.conversationId,
                ])
              ).rows,
            ).toEqual([{ status: 'queued' }, { status: 'queued' }, { status: 'queued' }]);
            await holder.query('COMMIT');
            const following = (await pending)[0]!;
            expect(following.status).toBe('fulfilled');
            if (following.status !== 'fulfilled') throw following.reason;
            expect(committedFirst.affectedRunCount).toBe(firstScope === 'ancestor' ? 3 : 2);
            expect(following.value.receipt.affectedRunCount).toBe(
              firstScope === 'ancestor' ? 0 : 1,
            );
            const saved = await snapshot(f);
            expect(saved.commands).toHaveLength(2);
            expect(saved.markers).toHaveLength(3);
            expect(
              saved.receipts.filter(
                (row: { run_status: string }) => row.run_status === 'cancelled',
              ),
            ).toHaveLength(3);
            expect(saved.tasks.map((row: { status: string }) => row.status)).toEqual([
              'cancelled',
              'cancelled',
              'cancelled',
            ]);
            expect(saved.runs.map((row: { status: string }) => row.status)).toEqual([
              'cancelled',
              'cancelled',
              'cancelled',
            ]);
            expect(
              (
                await admin.query(
                  "SELECT metadata->>'runId' AS run_id FROM audit_events WHERE event_type='task.cancelled' AND metadata->>'conversationId'=$1 ORDER BY metadata->>'runId'",
                  [f.conversationId],
                )
              ).rows.map((row: { run_id: string }) => row.run_id),
            ).toEqual([rootTarget.runId, middle.runId, leaf.runId].sort());
            expect((await cancel(f, first.id, first.runId, 'overlap-first')).receipt).toEqual(
              committedFirst,
            );
            expect((await cancel(f, second.id, second.runId, 'overlap-second')).receipt).toEqual(
              following.value.receipt,
            );
            expect(await snapshot(f)).toEqual(saved);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            await pending;
            await observer.pool.end();
          }
        },
      );

      it.each(['claim', 'delta', 'finish'] as const)(
        'rechecks a %s waiting behind an uncommitted cancellation using actual PostgreSQL blockers',
        async (kind) => {
          const f = await fixture(),
            task = await submit(f),
            queue = new TaskQueue(runtime);
          const claim = kind === 'claim' ? undefined : (await queue.claimNext()).claim!;
          if (claim) await queue.publishDelta(claim, 'Before cancellation');
          const holder = await runtime.connect(),
            observer = observedPool();
          let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
          try {
            await holder.query('BEGIN');
            await cancelInTransaction(
              holder,
              {
                actorUserId: f.actorId,
                workspaceId: f.workspaceId,
                conversationId: f.conversationId,
              },
              task.id,
              { idempotencyKey: 'blocked-cancel', expectedRunId: task.runs[0]!.id },
              () => new Date(),
            );
            const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const waiting = new TaskQueue(observer.pool);
            pending = Promise.allSettled([
              kind === 'claim'
                ? waiting.claimNext()
                : kind === 'delta'
                  ? waiting.publishDelta(claim!, 'Must not persist')
                  : waiting.finish(claim!, { body: 'Must not become final', usage: null }),
            ]);
            await blocked(observer.name, pid);
            expect(
              (await admin.query('SELECT status FROM tasks WHERE id=$1', [task.id])).rows[0].status,
            ).toBe(kind === 'claim' ? 'queued' : 'running');
            await holder.query('COMMIT');
            const result = (await pending)[0]!;
            if (kind === 'delta')
              expect(result).toMatchObject({
                status: 'rejected',
                reason: { code: 'worker_stopped' },
              });
            else
              expect(result).toMatchObject({
                status: 'fulfilled',
                value: kind === 'claim' ? { handled: false } : false,
              });
            const after = await snapshot(f);
            expect(
              after.events.filter(
                (event: { event_type: string }) => event.event_type === 'bot.message.created',
              ),
            ).toEqual([]);
            expect(after.partials?.[0]?.body ?? null).toBe(
              kind === 'claim' ? null : 'Before cancellation',
            );
            expect(
              after.receipts.filter(
                (row: { run_status: string }) => row.run_status === 'cancelled',
              ),
            ).toHaveLength(1);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            await pending;
            await observer.pool.end();
          }
        },
      );

      it('commits a delta, full partial and stream progress before a blocked cancel can observe the transaction', async () => {
        const f = await fixture(),
          task = await submit(f),
          queue = new TaskQueue(runtime),
          claim = (await queue.claimNext()).claim!;
        const holder = await runtime.connect(),
          observer = observedPool();
        let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
          await holder.query('BEGIN');
          await ConversationTransaction.lock(holder, {
            actorUserId: f.actorId,
            workspaceId: f.workspaceId,
            conversationId: f.conversationId,
          });
          expect(
            await appendAssistantDelta(
              holder,
              {
                runId: claim.runId,
                claimToken: claim.claimToken,
                text: 'Committed before stop 🌳',
              },
              () => new Date(),
            ),
          ).toBe(true);
          const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          pending = Promise.allSettled([
            cancel(f, task.id, claim.runId, 'after-delta', observer.pool),
          ]);
          await blocked(observer.name, pid);
          expect(
            (
              await admin.query('SELECT * FROM task_run_partial_outputs WHERE run_id=$1', [
                claim.runId,
              ])
            ).rows,
          ).toEqual([]);
          await holder.query('COMMIT');
          expect((await pending)[0]).toMatchObject({ status: 'fulfilled' });
          const result = await new TaskService(runtime).partialOutput(
            f.actorId,
            f.workspaceId,
            f.conversationId,
            task.id,
            claim.runId,
          );
          expect(result.partial).toEqual({
            text: 'Committed before stop 🌳',
            endByte: Buffer.byteLength('Committed before stop 🌳'),
            interrupted: true,
          });
          expect(
            (
              await admin.query('SELECT delivered_bytes FROM task_run_streams WHERE run_id=$1', [
                claim.runId,
              ])
            ).rows[0].delivered_bytes,
          ).toBe(result.partial!.endByte);
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
          await pending;
          await observer.pool.end();
        }
      });

      it('serializes an ancestor cancellation ahead of a failed child retry without changing its terminal Run', async () => {
        const f = await fixture('workspace', true),
          root = await submit(f),
          leaf = await child(f, root.id),
          claims = await claimAll();
        await new TaskQueue(runtime).finish(claims.get(leaf.id)!, {
          error: 'provider_failed',
          usage: null,
        });
        const before = (await admin.query('SELECT * FROM task_runs WHERE task_id=$1', [leaf.id]))
          .rows;
        const holder = await runtime.connect(),
          observer = observedPool();
        let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
          await holder.query('BEGIN');
          await cancelInTransaction(
            holder,
            {
              actorUserId: f.actorId,
              workspaceId: f.workspaceId,
              conversationId: f.conversationId,
            },
            root.id,
            { idempotencyKey: 'ancestor-first', expectedRunId: root.runs[0]!.id },
            () => new Date(),
          );
          const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          pending = Promise.allSettled([
            new TaskService(observer.pool).retry(
              f.actorId,
              f.workspaceId,
              f.conversationId,
              leaf.id,
              { idempotencyKey: 'child-after', expectedRunId: leaf.runId },
            ),
          ]);
          await blocked(observer.name, pid);
          await holder.query('COMMIT');
          expect((await pending)[0]).toMatchObject({
            status: 'rejected',
            reason: { code: 'task_retry_cancelled_ancestor' },
          });
          expect(
            (await admin.query('SELECT * FROM task_runs WHERE task_id=$1', [leaf.id])).rows,
          ).toEqual(before);
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
          await pending;
          await observer.pool.end();
        }
      });

      it('lets a child retry committed first be included by the waiting ancestor command while preserving its prior receipt', async () => {
        const f = await fixture('workspace', true),
          root = await submit(f),
          leaf = await child(f, root.id),
          claims = await claimAll();
        await new TaskQueue(runtime).finish(claims.get(leaf.id)!, {
          error: 'provider_failed',
          usage: null,
        });
        const holder = await runtime.connect(),
          first = observedPool(),
          second = observedPool();
        const retryKey = { idempotencyKey: 'retry-before-ancestor', expectedRunId: leaf.runId };
        let retry: ReturnType<TaskService['retry']> | undefined,
          cancellation: ReturnType<TaskService['cancel']> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
          const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          retry = new TaskService(first.pool).retry(
            f.actorId,
            f.workspaceId,
            f.conversationId,
            leaf.id,
            retryKey,
          );
          const retryObserved = Promise.allSettled([retry]);
          await blocked(first.name, pid);
          cancellation = cancel(f, root.id, root.runs[0]!.id, 'ancestor-after-retry', second.pool);
          const cancelObserved = Promise.allSettled([cancellation]);
          await blocked(second.name, pid);
          await holder.query('COMMIT');
          expect((await retryObserved)[0]).toMatchObject({ status: 'fulfilled' });
          expect((await cancelObserved)[0]).toMatchObject({ status: 'fulfilled' });
          const retried = await retry,
            stopped = await cancellation;
          expect(stopped.receipt.affectedRunCount).toBe(2);
          expect((await read(f, leaf.id)).runs[0]).toMatchObject({
            id: retried.receipt.runId,
            attempt: 2,
            status: 'cancelled',
          });
          expect(
            (
              await new TaskService(runtime).retry(
                f.actorId,
                f.workspaceId,
                f.conversationId,
                leaf.id,
                retryKey,
              )
            ).receipt,
          ).toEqual(retried.receipt);
          expect(
            (await admin.query('SELECT status FROM task_runs WHERE id=$1', [leaf.runId])).rows[0]
              .status,
          ).toBe('failed');
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
          await Promise.allSettled([retry, cancellation]);
          await first.pool.end();
          await second.pool.end();
        }
      });

      it('grants only cancellation writes, denies audit reads and keeps root identities and retained receipts immutable', async () => {
        const privileges = (
          await runtime.query(`SELECT
        has_table_privilege(current_user,'task_cancel_commands','SELECT') AS command_select,
        has_table_privilege(current_user,'task_cancel_commands','INSERT') AS command_insert,
        has_table_privilege(current_user,'task_cancel_commands','UPDATE') AS command_update,
        has_table_privilege(current_user,'task_cancel_commands','DELETE') AS command_delete,
        has_table_privilege(current_user,'task_run_cancellations','UPDATE') AS marker_update,
        has_table_privilege(current_user,'task_run_cancellations','DELETE') AS marker_delete,
        has_table_privilege(current_user,'task_run_partial_outputs','UPDATE') AS partial_table_update,
        has_table_privilege(current_user,'audit_events','SELECT') AS audit_select,
        has_function_privilege(current_user,'lock_task_ancestry(uuid)','EXECUTE') AS ancestry_execute,
        has_function_privilege(current_user,'require_cancelled_task_tree()','EXECUTE') AS audit_guard_execute`)
        ).rows[0];
        expect(privileges).toEqual({
          command_select: true,
          command_insert: true,
          command_update: false,
          command_delete: false,
          marker_update: false,
          marker_delete: false,
          partial_table_update: false,
          audit_select: false,
          ancestry_execute: true,
          audit_guard_execute: false,
        });
        expect(
          (
            await runtime.query(
              "SELECT column_name,has_column_privilege(current_user,'task_run_partial_outputs',column_name,'UPDATE') AS allowed FROM information_schema.columns WHERE table_schema='public' AND table_name='task_run_partial_outputs' ORDER BY column_name",
            )
          ).rows,
        ).toEqual([
          { column_name: 'body', allowed: true },
          { column_name: 'end_byte', allowed: true },
          { column_name: 'run_id', allowed: false },
          { column_name: 'updated_at', allowed: true },
        ]);
        const f = await fixture(),
          task = await submit(f),
          runId = task.runs[0]!.id;
        await expect(
          runtime.query('UPDATE tasks SET root_task_id=id WHERE id=$1', [task.id]),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          admin.query('UPDATE tasks SET parent_task_id=id WHERE id=$1', [task.id]),
        ).rejects.toMatchObject({ code: '55000' });
        await cancel(f, task.id, runId);
        const before = await snapshot(f);
        for (const pool of [runtime, admin])
          for (const table of ['task_cancel_commands', 'task_run_cancellations'])
            await expect(pool.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
              code: pool === runtime ? '42501' : '55000',
            });
        expect(await snapshot(f)).toEqual(before);
      });
    });
  },
);

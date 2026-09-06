import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { MIGRATION_VERSIONS } from './dist/database/migrations.js';
import { writeNextAttempt } from './dist/tasks/next-attempt.js';
import { TaskQueue } from './dist/tasks/queue.js';
const API = 'http://127.0.0.1:3001',
  PROVIDER = 'http://limits-provider:3100';
const credentials = {
  email: 'limits-owner@example.com',
  password: 'ci-only-limits-owner-password',
};
const prefix = 'Partial draft.',
  mode = process.env.OPENBOT_LIMITS_SMOKE_STAGE;
const pool = new pg.Pool({
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  statement_timeout: 5000,
});
let stage = mode;
async function request(path, { cookie, method = 'GET', body, setup = false } = {}) {
  const response = await fetch(API + path, {
    method,
    headers: {
      origin: process.env.WEB_ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(setup ? { 'x-openbot-setup-token': process.env.OPENBOT_SETUP_TOKEN } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  return { response, value: response.status === 204 ? undefined : await response.json() };
}
const stats = async () =>
  (await fetch(PROVIDER + '/stats', { signal: AbortSignal.timeout(2000) })).json();
async function until(check) {
  for (let i = 0; i < 160; i++) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error('durable execution-limit state was not reached');
}
function safe(value) {
  assert.doesNotMatch(
    JSON.stringify(value),
    /compose-private-provider-key|sealedCredentials|claim_token|private upstream/iu,
  );
}
try {
  assert.ok(['seed', 'timeout', 'grant', 'concurrency'].includes(mode));
  if (mode === 'seed' || mode === 'concurrency') {
    const setup = await request('/api/v1/setup', {
      method: 'POST',
      setup: true,
      body: { ...credentials, displayName: 'Limits owner' },
    });
    assert.equal(setup.response.status, 201);
  }
  const login = await request('/api/v1/session', { method: 'POST', body: credentials });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const workspaceId = login.value.workspace.id,
    base = `/api/v1/workspaces/${workspaceId}`;
  assert.deepEqual(
    (await pool.query('SELECT version FROM openbot_schema_migrations ORDER BY version')).rows.map(
      (row) => row.version,
    ),
    MIGRATION_VERSIONS,
  );
  assert.equal(MIGRATION_VERSIONS.at(-1), '0043_task_parallel_delegations');
  assert.deepEqual(
    (
      await pool.query(
        'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows,
    [{ name: 'openbot_runtime', rolsuper: false, rolbypassrls: false }],
  );
  if (mode === 'concurrency') {
    stage = 'default group never runs a fifth concurrent Bot';
    const shared = await request(`${base}/model-connections`, {
      cookie,
      method: 'POST',
      body: {
        name: 'Concurrency Compose provider',
        protocol: 'openai-chat',
        baseUrl: PROVIDER + '/v1',
        modelId: 'limits-compose-model',
        apiKey: 'compose-private-provider-key',
        headers: {},
      },
    });
    assert.equal(shared.response.status, 201);
    const group = await request(`${base}/groups`, {
      cookie,
      method: 'POST',
      body: { name: 'Concurrency group' },
    });
    assert.equal(group.response.status, 201);
    const bot = await request(base + '/bots', {
      cookie,
      method: 'POST',
      body: {
        name: 'Compose Concurrency Bot',
        roleDescription: 'Concurrency evidence',
        instructions: 'Stay inside the default group cap.',
        modelBinding: {
          scope: { kind: 'workspace', id: workspaceId },
          connectionId: shared.value.connection.id,
          modelId: 'limits-compose-model',
        },
      },
    });
    assert.equal(bot.response.status, 201);
    const invited = await request(`${base}/groups/${group.value.group.id}/bots`, {
      cookie,
      method: 'POST',
      body: { botId: bot.value.bot.id, idempotencyKey: 'concurrency-invite' },
    });
    assert.equal(invited.response.status, 200);
    const conversationId = invited.value.grant.conversationId;
    const path = `${base}/conversations/${conversationId}/tasks`;
    const tasks = [];
    for (let index = 0; index < 5; index++) {
      const queued = await request(path, {
        cookie,
        method: 'POST',
        body: {
          idempotencyKey: `concurrency-${index}`,
          body: `concurrency-${index}`,
          groupGrantId: invited.value.grant.id,
        },
      });
      assert.equal(queued.response.status, 202);
      assert.equal(queued.value.task.status, 'queued');
      tasks.push(queued.value.task);
    }
    const queue = new TaskQueue(pool);
    const claimed = [];
    for (let index = 0; index < 4; index++) {
      const next = await queue.claimNext();
      assert.equal(next.claim?.taskId, tasks[index].id);
      claimed.push(next.claim);
    }
    assert.deepEqual(await queue.claimNext(), { handled: false });
    const held = await request(`${path}/${tasks[4].id}`, { cookie });
    assert.equal(held.response.status, 200);
    safe(held.value);
    assert.equal(held.value.task.status, 'queued');
    assert.equal(held.value.task.runs[0].status, 'queued');
    assert.deepEqual(held.value.task.runs[0].queueHold, {
      reason: 'concurrency',
      layer: 'group',
      limit: 4,
      used: 4,
    });
    assert.deepEqual(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM task_runs r
           JOIN tasks t ON t.id=r.task_id
           JOIN conversations c ON c.id=t.conversation_id
           WHERE r.status='running' AND c.group_id=$1`,
          [group.value.group.id],
        )
      ).rows,
      [{ n: 4 }],
    );
    assert.equal(await queue.finish(claimed[0], { body: 'Released slot.', usage: null }), true);
    assert.equal((await queue.claimNext()).claim?.taskId, tasks[4].id);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (
          await pool.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [
            'task_run_concurrency_holds',
            privilege,
          ])
        ).rows[0].allowed,
        ['SELECT', 'INSERT', 'DELETE'].includes(privilege),
      );
    assert.equal(
      (
        await pool.query(
          "SELECT has_column_privilege(current_user,'tasks','execution_policy','UPDATE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
  } else {
    const find = async () => {
      const row = (
        await pool.query(
          'SELECT t.id,t.conversation_id,t.execution_user_id,t.workspace_id FROM tasks t JOIN conversation_events e ON e.id=t.trigger_event_id WHERE t.workspace_id=$1 AND e.idempotency_key=$2',
          [workspaceId, 'limit-budget'],
        )
      ).rows[0];
      assert.ok(row);
      return row;
    };
    if (mode === 'seed') {
      stage = 'snapshotted Task limits while the worker is unconfigured';
      const model = await request('/api/v1/model-connections', {
        cookie,
        method: 'POST',
        body: {
          name: 'Limits Compose provider',
          protocol: 'openai-chat',
          baseUrl: PROVIDER + '/v1',
          modelId: 'limits-compose-model',
          apiKey: 'compose-private-provider-key',
          headers: {},
        },
      });
      assert.equal(model.response.status, 201);
      const bot = await request(base + '/bots', {
        cookie,
        method: 'POST',
        body: {
          name: 'Compose Limits Bot',
          roleDescription: 'Limit evidence',
          instructions: 'Stay inside the snapshotted cap.',
          limits: { maxDurationSeconds: 1 },
          retryPolicy: { maxAttemptsPerModel: 2, maxRunsPerChain: 4 },
          modelBinding: {
            scope: { kind: 'personal', id: login.value.user.id },
            connectionId: model.value.id,
            modelId: 'limits-compose-model',
          },
        },
      });
      assert.equal(bot.response.status, 201);
      const opened = await request(base + '/conversations', {
        cookie,
        method: 'POST',
        body: { subject: { kind: 'direct-bot', id: bot.value.bot.id } },
      });
      assert.equal(opened.response.status, 200);
      const path = `${base}/conversations/${opened.value.conversation.id}/tasks`;
      const queued = await request(path, {
        cookie,
        method: 'POST',
        body: { idempotencyKey: 'limit-budget', body: 'limit-budget' },
      });
      assert.equal(queued.response.status, 202);
      assert.equal(queued.value.task.status, 'queued');
      const snapshot = (
        await pool.query(
          'SELECT max_duration_ms,duration_source FROM task_execution_limit_snapshots WHERE task_id=$1',
          [queued.value.task.id],
        )
      ).rows[0];
      assert.equal(Number(snapshot.max_duration_ms), 1000);
      assert.equal(snapshot.duration_source, 'task');
      assert.deepEqual((await stats()).calls, [
        { modelId: 'limits-compose-model', prompt: 'Reply with OK.' },
      ]);
    } else {
      const selected = await find(),
        path = `${base}/conversations/${selected.conversation_id}/tasks`;
      const read = async () => {
        const response = await request(`${path}/${selected.id}`, { cookie });
        assert.equal(response.response.status, 200);
        safe(response.value);
        return response.value.task;
      };
      if (mode === 'timeout') {
        stage = 'snapshotted duration timeout stays failed, then hard hold';
        let current = new Date();
        const queue = new TaskQueue(pool, () => current);
        const { claim } = await queue.claimNext();
        assert.ok(claim);
        assert.equal(claim.deadlineAt.getTime() - current.getTime(), 1000);
        await queue.publishDelta(claim, prefix);
        current = new Date(claim.deadlineAt.getTime() + 1);
        assert.equal(
          await queue.finish(claim, {
            body: 'Too late to complete.',
            usage: { inputTokens: 2, outputTokens: 1 },
          }),
          true,
        );
        const timedOut = await read();
        assert.equal(timedOut.status, 'failed');
        assert.equal(timedOut.runCount, 1);
        assert.equal(timedOut.runs[0].error, 'execution_timeout');
        assert.equal(timedOut.runs[0].output, null);
        assert.deepEqual(
          (
            await pool.query('SELECT body FROM task_run_partial_outputs WHERE run_id=$1', [
              claim.runId,
            ])
          ).rows,
          [{ body: prefix }],
        );
        assert.deepEqual(
          (
            await pool.query(
              `SELECT event_type FROM conversation_events
             WHERE conversation_id=$1 AND event_type='task.limit.warning'`,
              [selected.conversation_id],
            )
          ).rows,
          [],
        );
        const binding = {
          scope: { kind: 'personal', id: selected.execution_user_id },
          connectionId: (
            await pool.query(
              "SELECT configuration->'modelBinding'->>'connectionId' AS id FROM bot_versions v JOIN tasks t ON t.bot_version_id=v.id WHERE t.id=$1",
              [selected.id],
            )
          ).rows[0].id,
          modelId: 'limits-compose-model',
        };
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          assert.deepEqual(
            await writeNextAttempt(connection, {
              taskId: selected.id,
              sourceRunId: claim.runId,
              workspaceId: selected.workspace_id,
              conversationId: selected.conversation_id,
              executionUserId: selected.execution_user_id,
              sourceAttempt: 1,
              plan: {
                origin: 'provider_retry',
                reason: 'provider_rate_limited',
                binding,
                previousBinding: binding,
                notBefore: current,
                delayMs: 0,
                jitterMs: 0,
                chainRootRunId: claim.runId,
                previousRunId: claim.runId,
                chainAttemptOrdinal: 2,
                chainLimitSnapshot: 4,
                modelAttemptOrdinal: 1,
              },
              now: current,
            }),
            { scheduled: false, reason: 'budget' },
          );
          await connection.query('COMMIT');
        } finally {
          connection.release();
        }
        const held = await read();
        assert.equal(held.status, 'waiting_budget');
        assert.equal(held.runCount, 1);
        assert.equal(held.runs[0].error, 'execution_timeout');
        assert.equal(
          (await stats()).calls.filter((call) => call.prompt === 'limit-budget').length,
          0,
        );
      } else {
        stage = 'authorized grant resumes waiting_budget without rewriting the snapshot';
        const held = await read();
        assert.equal(held.status, 'waiting_budget');
        const snapshot = (
          await pool.query(
            'SELECT max_duration_ms,duration_source FROM task_execution_limit_snapshots WHERE task_id=$1',
            [selected.id],
          )
        ).rows[0];
        assert.equal(Number(snapshot.max_duration_ms), 1000);
        const granted = await request(`${path}/${selected.id}/limit-grants`, {
          cookie,
          method: 'POST',
          body: { idempotencyKey: 'raise-duration', dimension: 'duration', limit: 5000 },
        });
        assert.equal(granted.response.status, 202);
        assert.equal(granted.value.task.status, 'queued');
        assert.equal(granted.value.grant.dimension, 'duration');
        assert.equal(granted.value.grant.previousLimit, 1000);
        assert.equal(granted.value.grant.grantedLimit, 5000);
        assert.equal(granted.value.grant.attempt, 2);
        const replay = await request(`${path}/${selected.id}/limit-grants`, {
          cookie,
          method: 'POST',
          body: { idempotencyKey: 'raise-duration', dimension: 'duration', limit: 5000 },
        });
        assert.equal(replay.response.status, 202);
        assert.equal(replay.value.grant.grantId, granted.value.grant.grantId);
        await until(async () => (await read()).status === 'completed');
        const completed = await read();
        assert.equal(completed.runCount, 2);
        assert.equal(completed.runs[0].status, 'completed');
        assert.equal(completed.runs[0].id, granted.value.grant.runId);
        const runs = (
          await pool.query(
            'SELECT attempt,status,error_code FROM task_runs WHERE task_id=$1 ORDER BY attempt',
            [selected.id],
          )
        ).rows;
        assert.deepEqual(runs, [
          { attempt: 1, status: 'failed', error_code: 'execution_timeout' },
          { attempt: 2, status: 'completed', error_code: null },
        ]);
        assert.equal(
          Number(
            (
              await pool.query(
                'SELECT max_duration_ms FROM task_execution_limit_snapshots WHERE task_id=$1',
                [selected.id],
              )
            ).rows[0].max_duration_ms,
          ),
          1000,
        );
        const provider = await stats();
        assert.equal(provider.calls.filter((call) => call.prompt === 'limit-budget').length, 1);
        safe(completed);
      }
    }
  }
} catch (error) {
  console.error(stage, error);
  process.exit(1);
} finally {
  await pool.end();
}

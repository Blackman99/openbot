import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { MIGRATION_VERSIONS } from './dist/database/migrations.js';

const API = 'http://127.0.0.1:3001',
  PROVIDER = 'http://limit-provider:3100';
const credentials = {
  email: 'limit-owner@example.com',
  password: 'ci-only-limit-owner-password',
};
const mode = process.env.OPENBOT_LIMIT_SMOKE_STAGE;
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
  for (let i = 0; i < 100; i++) {
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
  assert.ok(['seed', 'held', 'granted'].includes(mode));
  if (mode === 'seed') {
    const setup = await request('/api/v1/setup', {
      method: 'POST',
      setup: true,
      body: { ...credentials, displayName: 'Limit owner' },
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
  assert.equal(MIGRATION_VERSIONS.at(-1), '0036_task_execution_limit_snapshots');
  assert.deepEqual(
    (
      await pool.query(
        'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows,
    [{ name: 'openbot_runtime', rolsuper: false, rolbypassrls: false }],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='protect_task_execution_limit_snapshot'",
      )
    ).rows.length,
    1,
  );
  if (mode === 'seed') {
    stage = 'workspace policy and immutable snapshot while the worker is unconfigured';
    const policy = await request(`${base}/execution-limits`, {
      cookie,
      method: 'PUT',
      body: { maxDurationSeconds: 60, maxTurns: 4 },
    });
    assert.equal(policy.response.status, 200);
    assert.deepEqual(policy.value.policy, { maxDurationSeconds: 60, maxTurns: 4 });
    const model = await request('/api/v1/model-connections', {
      cookie,
      method: 'POST',
      body: {
        name: 'Limit Compose provider',
        protocol: 'openai-chat',
        baseUrl: PROVIDER + '/v1',
        modelId: 'limit-compose-model',
        apiKey: 'compose-private-provider-key',
        headers: {},
      },
    });
    assert.equal(model.response.status, 201);
    const bot = await request(`${base}/bots`, {
      cookie,
      method: 'POST',
      body: {
        name: 'Compose Limit Bot',
        roleDescription: 'Limit evidence',
        instructions: 'Use the durable worker.',
        modelBinding: {
          scope: { kind: 'personal', id: login.value.user.id },
          connectionId: model.value.id,
          modelId: 'limit-compose-model',
        },
      },
    });
    assert.equal(bot.response.status, 201);
    const opened = await request(`${base}/conversations`, {
      cookie,
      method: 'POST',
      body: { subject: { kind: 'direct-bot', id: bot.value.bot.id } },
    });
    assert.equal(opened.response.status, 200);
    const submitted = await request(`${base}/conversations/${opened.value.conversation.id}/tasks`, {
      cookie,
      method: 'POST',
      body: {
        idempotencyKey: 'limit-zero-turns',
        body: 'hold-budget',
        policy: { maxTurns: 0 },
      },
    });
    assert.equal(submitted.response.status, 202);
    assert.equal(submitted.value.task.status, 'queued');
    assert.deepEqual(submitted.value.task.limits, {
      durationMs: 60_000,
      durationSource: 'workspace',
      turns: 0,
      turnsSource: 'task',
      depth: 2,
      depthSource: 'task',
      handoffs: 32,
      handoffsSource: 'run',
      usage: { durationMs: 0, turns: 0, depth: 0, handoffs: 0 },
      warnings: [],
    });
    safe(submitted.value);
    assert.deepEqual((await stats()).calls, []);
  } else {
    const row = (
      await pool.query(
        `SELECT t.id,t.conversation_id FROM tasks t
         JOIN conversation_events e ON e.id=t.trigger_event_id
         WHERE t.workspace_id=$1 AND e.idempotency_key=$2`,
        [workspaceId, 'limit-zero-turns'],
      )
    ).rows[0];
    assert.ok(row);
    const path = `${base}/conversations/${row.conversation_id}/tasks`;
    const read = async () => {
      const response = await request(`${path}/${row.id}`, { cookie });
      assert.equal(response.response.status, 200);
      safe(response.value);
      return response.value.task;
    };
    if (mode === 'held') {
      stage = 'claim holds waiting_budget without a provider call';
      await until(async () => (await read()).status === 'waiting_budget');
      const task = await read();
      assert.equal(task.runs[0].status, 'waiting_budget');
      assert.equal(task.runs[0].startedAt, null);
      assert.equal(task.runs[0].provider, null);
      assert.equal(task.limits.turns, 0);
      assert.equal(task.limits.warnings[0]?.kind, 'hard_limit');
      assert.deepEqual((await stats()).calls, []);
      assert.equal(
        (
          await pool.query(
            "SELECT event_type FROM audit_events WHERE event_type='task.limit.held' AND metadata->>'taskId'=$1",
            [row.id],
          )
        ).rows.length,
        1,
      );
    } else {
      stage = 'authorized grant resumes without rewriting the snapshot or usage';
      const usage = (
        await pool.query(
          "SELECT usage FROM task_limit_events WHERE task_id=$1 AND kind='hard_limit'",
          [row.id],
        )
      ).rows;
      const command = { idempotencyKey: 'compose-grant-turns', dimension: 'turns', limit: 2 };
      const granted = await request(`${path}/${row.id}/limit-grants`, {
        cookie,
        method: 'POST',
        body: command,
      });
      assert.equal(granted.response.status, 200);
      assert.equal(granted.value.grant.previousLimit, 0);
      assert.equal(granted.value.grant.grantedLimit, 2);
      assert.equal(granted.value.task.status, 'queued');
      const replay = await request(`${path}/${row.id}/limit-grants`, {
        cookie,
        method: 'POST',
        body: command,
      });
      assert.equal(replay.response.status, 200);
      assert.deepEqual(replay.value.grant, granted.value.grant);
      await until(async () => (await read()).status === 'completed');
      const completed = await read();
      assert.equal(completed.limits.turns, 2);
      assert.equal(completed.limits.usage.turns, 1);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT max_turns,turns_source FROM task_execution_limit_snapshots WHERE task_id=$1',
            [row.id],
          )
        ).rows,
        [{ max_turns: 0, turns_source: 'task' }],
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT usage FROM task_limit_events WHERE task_id=$1 AND kind='hard_limit'",
            [row.id],
          )
        ).rows,
        usage,
      );
      assert.equal((await stats()).calls.length, 1);
    }
  }
} catch (error) {
  console.error(`COL-12 compose ${stage} failed`);
  throw error;
} finally {
  await pool.end();
}

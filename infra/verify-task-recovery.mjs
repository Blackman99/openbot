import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { MIGRATION_VERSIONS } from './dist/database/migrations.js';
const API = 'http://127.0.0.1:3001',
  PROVIDER = 'http://recovery-provider:3100';
const credentials = {
  email: 'recovery-owner@example.com',
  password: 'ci-only-recovery-owner-password',
};
const prefix = 'Persisted interrupted 🌿',
  mode = process.env.OPENBOT_RECOVERY_SMOKE_STAGE;
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
  throw new Error('durable recovery state was not reached');
}
function safe(value) {
  assert.doesNotMatch(
    JSON.stringify(value),
    /compose-private-provider-key|sealedCredentials|claim_token|private upstream/iu,
  );
}
try {
  assert.ok(['seed', 'killed', 'recovered'].includes(mode));
  if (mode === 'seed') {
    const setup = await request('/api/v1/setup', {
      method: 'POST',
      setup: true,
      body: { ...credentials, displayName: 'Recovery owner' },
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
  assert.equal(MIGRATION_VERSIONS.at(-1), '0042_task_token_budgets');
  assert.deepEqual(
    (
      await pool.query(
        'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows,
    [{ name: 'openbot_runtime', rolsuper: false, rolbypassrls: false }],
  );
  if (mode === 'seed') {
    stage = 'real provider capability and queued recovery work while worker is unconfigured';
    const model = await request('/api/v1/model-connections', {
      cookie,
      method: 'POST',
      body: {
        name: 'Recovery Compose provider',
        protocol: 'openai-chat',
        baseUrl: PROVIDER + '/v1',
        modelId: 'recovery-compose-model',
        apiKey: 'compose-private-provider-key',
        headers: {},
      },
    });
    assert.equal(model.response.status, 201);
    const bot = await request(base + '/bots', {
      cookie,
      method: 'POST',
      body: {
        name: 'Compose Recovery Bot',
        roleDescription: 'Recovery evidence',
        instructions: 'Use the durable worker.',
        modelBinding: {
          scope: { kind: 'personal', id: login.value.user.id },
          connectionId: model.value.id,
          modelId: 'recovery-compose-model',
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
    const running = await request(path, {
      cookie,
      method: 'POST',
      body: { idempotencyKey: 'recover-running', body: 'recover-running' },
    });
    assert.equal(running.response.status, 202);
    assert.equal(running.value.task.status, 'queued');
    const after = await request(path, {
      cookie,
      method: 'POST',
      body: { idempotencyKey: 'recover-after', body: 'recover-after' },
    });
    assert.equal(after.response.status, 202);
    assert.deepEqual((await stats()).calls, []);
  } else {
    const find = async (key) => {
      const row = (
        await pool.query(
          'SELECT t.id,t.conversation_id FROM tasks t JOIN conversation_events e ON e.id=t.trigger_event_id WHERE t.workspace_id=$1 AND e.idempotency_key=$2',
          [workspaceId, key],
        )
      ).rows[0];
      assert.ok(row);
      return row;
    };
    const running = await find('recover-running'),
      after = await find('recover-after'),
      path = `${base}/conversations/${running.conversation_id}/tasks`;
    const read = async (id) => {
      const response = await request(`${path}/${id}`, { cookie });
      assert.equal(response.response.status, 200);
      safe(response.value);
      return response.value.task;
    };
    if (mode === 'killed') {
      stage = 'SIGKILL left the current claim running with an expired lease';
      const task = await read(running.id);
      assert.equal(task.status, 'running');
      assert.equal(task.runCount, 1);
      assert.equal(task.runs[0].error, null);
      const lease = (
        await pool.query('SELECT expires_at FROM task_run_leases WHERE run_id=$1', [
          task.runs[0].id,
        ])
      ).rows[0];
      assert.ok(lease);
      assert.ok(new Date(lease.expires_at).getTime() <= Date.now());
      assert.equal(
        (
          await pool.query(
            'SELECT source_run_id FROM task_run_recovery_receipts WHERE source_run_id=$1',
            [task.runs[0].id],
          )
        ).rows.length,
        0,
      );
      assert.equal((await read(after.id)).status, 'queued');
    } else {
      stage = 'restarted worker recovered once and published one final assistant message';
      await until(async () => (await read(running.id)).status === 'completed');
      const task = await read(running.id);
      assert.equal(task.runCount, 2);
      assert.equal(task.runs[0].status, 'completed');
      assert.equal(task.runs[0].error, null);
      assert.ok(task.runs[0].output);
      const runs = (
        await pool.query(
          'SELECT attempt,status,error_code FROM task_runs WHERE task_id=$1 ORDER BY attempt',
          [running.id],
        )
      ).rows;
      assert.deepEqual(runs, [
        { attempt: 1, status: 'failed', error_code: 'worker_interrupted' },
        { attempt: 2, status: 'completed', error_code: null },
      ]);
      const receipt = (
        await pool.query(
          'SELECT decision,stop_reason FROM task_run_recovery_receipts WHERE task_id=$1',
          [running.id],
        )
      ).rows;
      assert.deepEqual(receipt, [{ decision: 'queued_successor', stop_reason: null }]);
      const partial = (
        await pool.query('SELECT body FROM task_run_partial_outputs WHERE run_id=$1', [
          (
            await pool.query('SELECT id FROM task_runs WHERE task_id=$1 AND attempt=1', [
              running.id,
            ])
          ).rows[0].id,
        ])
      ).rows;
      assert.deepEqual(partial, [{ body: prefix }]);
      const afterTask = await read(after.id);
      assert.equal(afterTask.status, 'completed');
      assert.equal(afterTask.runCount, 1);
      const provider = await stats();
      assert.equal(provider.calls.filter((call) => call.prompt === 'recover-running').length, 2);
      assert.equal(provider.calls.filter((call) => call.prompt === 'recover-after').length, 1);
      safe(task);
      safe(afterTask);
    }
  }
} catch (error) {
  console.error(stage, error);
  process.exit(1);
} finally {
  await pool.end();
}

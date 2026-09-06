import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { cleanupConversationStreams } from './dist/conversations/stream-cleanup.js';
import { MIGRATION_VERSIONS } from './dist/database/migrations.js';
const API = 'http://127.0.0.1:3001',
  WEB = 'http://web:3000',
  PROVIDER = 'http://cancel-provider:3100';
const credentials = {
  email: 'cancel-owner@example.com',
  password: 'ci-only-cancel-owner-password',
};
const prefix = 'Persisted interrupted 🌿',
  mode = process.env.OPENBOT_CANCELLATION_SMOKE_STAGE;
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
  throw new Error('durable cancellation state was not reached');
}
function safe(value) {
  assert.doesNotMatch(
    JSON.stringify(value),
    /compose-private-provider-key|sealedCredentials|claim_token|private upstream/iu,
  );
}
try {
  assert.ok(['seed', 'cancel', 'reloaded'].includes(mode));
  if (mode === 'seed') {
    const setup = await request('/api/v1/setup', {
      method: 'POST',
      setup: true,
      body: { ...credentials, displayName: 'Cancellation owner' },
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
  assert.equal(MIGRATION_VERSIONS.at(-1), '0046_task_cost_budgets');
  assert.deepEqual(
    (
      await pool.query(
        'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows,
    [{ name: 'openbot_runtime', rolsuper: false, rolbypassrls: false }],
  );
  if (mode === 'seed') {
    stage = 'real provider capability and queued cancellation while worker is unconfigured';
    const model = await request('/api/v1/model-connections', {
      cookie,
      method: 'POST',
      body: {
        name: 'Cancellation Compose provider',
        protocol: 'openai-chat',
        baseUrl: PROVIDER + '/v1',
        modelId: 'cancel-compose-model',
        apiKey: 'compose-private-provider-key',
        headers: {},
      },
    });
    assert.equal(model.response.status, 201);
    const bot = await request(base + '/bots', {
      cookie,
      method: 'POST',
      body: {
        name: 'Compose Cancellation Bot',
        roleDescription: 'Cancellation evidence',
        instructions: 'Use the durable worker.',
        modelBinding: {
          scope: { kind: 'personal', id: login.value.user.id },
          connectionId: model.value.id,
          modelId: 'cancel-compose-model',
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
      body: { idempotencyKey: 'cancel-queued', body: 'cancel-queued' },
    });
    assert.equal(queued.response.status, 202);
    const command = {
      idempotencyKey: 'cancel-queued-command',
      expectedRunId: queued.value.task.runs[0].id,
    };
    const cancelled = await request(`${path}/${queued.value.task.id}/cancellations`, {
      cookie,
      method: 'POST',
      body: command,
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.value.task.status, 'cancelled');
    assert.equal(cancelled.value.task.runs[0].provider, null);
    assert.equal(cancelled.value.task.runs[0].startedAt, null);
    assert.deepEqual(
      (
        await request(`${path}/${queued.value.task.id}/cancellations`, {
          cookie,
          method: 'POST',
          body: command,
        })
      ).value,
      cancelled.value,
    );
    const zero = await request(`${path}/${queued.value.task.id}/cancellations`, {
      cookie,
      method: 'POST',
      body: { ...command, idempotencyKey: 'cancel-queued-zero' },
    });
    assert.equal(zero.response.status, 200);
    assert.equal(zero.value.receipt.affectedRunCount, 0);
    assert.equal(zero.value.receipt.cancelledAt, cancelled.value.receipt.cancelledAt);
    const running = await request(path, {
      cookie,
      method: 'POST',
      body: { idempotencyKey: 'cancel-running', body: 'cancel-running' },
    });
    assert.equal(running.response.status, 202);
    assert.equal(running.value.task.status, 'queued');
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
    const running = await find('cancel-running'),
      conversationId = running.conversation_id,
      path = `${base}/conversations/${conversationId}/tasks`,
      webBase = `/app/workspaces/${workspaceId}/conversations/${conversationId}`;
    const read = async (id) => {
      const response = await request(`${path}/${id}`, { cookie });
      assert.equal(response.response.status, 200);
      safe(response.value);
      return response.value.task;
    };
    const partial = async (task) => {
      const response = await request(`${path}/${task.id}/runs/${task.runs[0].id}/partial-output`, {
        cookie,
      });
      assert.equal(response.response.status, 200);
      assert.equal(response.response.headers.get('cache-control'), 'private, no-store');
      safe(response.value);
      return response.value;
    };
    async function stop(task, key, prompt) {
      const command = { idempotencyKey: key, expectedRunId: task.runs[0].id };
      const stopped = await request(`${path}/${task.id}/cancellations`, {
        cookie,
        method: 'POST',
        body: command,
      });
      assert.equal(stopped.response.status, 200);
      assert.equal(stopped.value.task.status, 'cancelled');
      await until(async () => (await stats()).aborted.some((entry) => entry.prompt === prompt));
      const closed = (await stats()).aborted.find((entry) => entry.prompt === prompt),
        delay = closed.at - Date.parse(stopped.value.receipt.cancelledAt);
      assert.ok(
        delay >= 0 && delay <= 1500,
        'responsive database cancellation must abort the HTTP request within the observation allowance',
      );
      console.info(`task_cancellation_${prompt}_http_abort_ms=${delay}`);
      assert.deepEqual(
        (
          await request(`${path}/${task.id}/cancellations`, {
            cookie,
            method: 'POST',
            body: command,
          })
        ).value,
        stopped.value,
      );
      return stopped.value.task;
    }
    if (mode === 'cancel') {
      stage = 'separate worker running while API had been stopped';
      await until(async () => (await read(running.id)).status === 'running');
      let task = await read(running.id);
      assert.deepEqual(task.runs[0].provider, {
        protocol: 'openai-chat',
        modelId: 'cancel-compose-model',
      });
      await until(
        async () =>
          (
            await pool.query('SELECT body,end_byte FROM task_run_partial_outputs WHERE run_id=$1', [
              task.runs[0].id,
            ])
          ).rows.length === 1,
      );
      assert.deepEqual(
        (
          await pool.query('SELECT body,end_byte FROM task_run_partial_outputs WHERE run_id=$1', [
            task.runs[0].id,
          ])
        ).rows,
        [{ body: prefix, end_byte: Buffer.byteLength(prefix) }],
      );
      assert.equal((await stats()).pending, 1);
      const bootstrap = await fetch(`${WEB}${webBase}/events/bootstrap`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(bootstrap.status, 200);
      const snapshot = await bootstrap.json();
      assert.equal(snapshot.previews[0].text, prefix);
      safe(snapshot);
      stage = 'cancelled durable state independently aborts the active HTTP provider';
      task = await stop(task, 'cancel-running-command', 'cancel-running');
      assert.deepEqual((await partial(task)).partial, {
        text: prefix,
        endByte: Buffer.byteLength(prefix),
        interrupted: true,
      });
      assert.equal(task.runs[0].output, null);
      await fetch(PROVIDER + '/release', { method: 'POST', signal: AbortSignal.timeout(2000) });
      assert.equal((await stats()).pending, 0);
      stage = 'same worker processes later independent work';
      const next = await request(path, {
        cookie,
        method: 'POST',
        body: { idempotencyKey: 'cancel-after', body: 'cancel-after' },
      });
      assert.equal(next.response.status, 202);
      await until(async () => (await read(next.value.task.id)).status === 'completed');
      stage = 'silent HTTP request has no invented prefix';
      const silent = await request(path, {
        cookie,
        method: 'POST',
        body: { idempotencyKey: 'cancel-silent', body: 'cancel-silent' },
      });
      assert.equal(silent.response.status, 202);
      await until(async () =>
        (await stats()).calls.some((entry) => entry.prompt === 'cancel-silent'),
      );
      const stopped = await stop(
        await read(silent.value.task.id),
        'cancel-silent-command',
        'cancel-silent',
      );
      assert.equal((await partial(stopped)).partial, null);
    } else {
      stage = 'restart and delivery reclamation retain cancelled Run output';
      const before = await read(running.id);
      assert.equal(before.status, 'cancelled');
      await cleanupConversationStreams(pool, new Date(Date.now() + 25 * 60 * 60 * 1000));
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM conversation_delivery_events WHERE conversation_id=$1',
            [conversationId],
          )
        ).rows[0].count,
        0,
      );
      assert.deepEqual((await partial(before)).partial, {
        text: prefix,
        endByte: Buffer.byteLength(prefix),
        interrupted: true,
      });
      const bff = await fetch(
        `${WEB}${webBase}/tasks/${before.id}/runs/${before.runs[0].id}/partial-output`,
        { headers: { cookie }, signal: AbortSignal.timeout(10000) },
      );
      assert.equal(bff.status, 200);
      assert.equal(bff.headers.get('cache-control'), 'private, no-store');
      assert.equal(bff.headers.get('set-cookie'), null);
      assert.deepEqual(await bff.json(), await partial(before));
      const page = await fetch(`${WEB}${webBase}/tasks/${before.id}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Interrupted output/u);
      assert.ok(html.includes(prefix));
      safe(html);
    }
    stage = 'retained counts and exactly one independent final output';
    const all = (await request(path, { cookie })).value.tasks;
    assert.equal(all.length, 4);
    assert.equal(all.filter((task) => task.status === 'cancelled').length, 3);
    assert.equal(all.filter((task) => task.status === 'completed').length, 1);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM task_runs')).rows[0].count,
      4,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM task_cancel_commands')).rows[0].count,
      4,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT body FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
      [{ body: 'Independent work completes.' }],
    );
    assert.deepEqual((await stats()).calls, [
      { prompt: 'cancel-running', modelId: 'cancel-compose-model' },
      { prompt: 'cancel-after', modelId: 'cancel-compose-model' },
      { prompt: 'cancel-silent', modelId: 'cancel-compose-model' },
    ]);
    assert.equal((await stats()).pending, 0);
    for (const key of ['cancel-queued', 'cancel-running', 'cancel-silent']) {
      const task = await read((await find(key)).id);
      assert.equal(task.status, 'cancelled');
      assert.equal(task.runs[0].output, null);
    }
    await assert.rejects(
      pool.query('DELETE FROM task_run_partial_outputs'),
      /canonical completed output/iu,
    );
  }
  console.info(`task_cancellation_smoke_${mode}_passed`);
} catch {
  console.error(`Task cancellation Compose smoke failed during ${stage}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

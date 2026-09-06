import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { cleanupConversationStreams } from './dist/conversations/stream-cleanup.js';
import { MIGRATION_VERSIONS } from './dist/database/migrations.js';
const API = 'http://127.0.0.1:3001',
  WEB = 'http://web:3000',
  PROVIDER = 'http://pause-provider:3100';
const credentials = {
  email: 'pause-owner@example.com',
  password: 'ci-only-pause-owner-password',
};
const prefix = 'Persisted interrupted 🌿',
  mode = process.env.OPENBOT_PAUSE_SMOKE_STAGE;
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
  throw new Error('durable pause/resume state was not reached');
}
function safe(value) {
  assert.doesNotMatch(
    JSON.stringify(value),
    /compose-private-provider-key|sealedCredentials|claim_token|private upstream/iu,
  );
}
try {
  assert.ok(['seed', 'pause', 'reloaded'].includes(mode));
  if (mode === 'seed') {
    const setup = await request('/api/v1/setup', {
      method: 'POST',
      setup: true,
      body: { ...credentials, displayName: 'Pause owner' },
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
  assert.equal(MIGRATION_VERSIONS.at(-1), '0052_routine_occurrences');
  assert.deepEqual(
    (
      await pool.query(
        'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows,
    [{ name: 'openbot_runtime', rolsuper: false, rolbypassrls: false }],
  );
  if (mode === 'seed') {
    stage = 'real provider capability and queued pause while worker is unconfigured';
    const model = await request('/api/v1/model-connections', {
      cookie,
      method: 'POST',
      body: {
        name: 'Pause Compose provider',
        protocol: 'openai-chat',
        baseUrl: PROVIDER + '/v1',
        modelId: 'pause-compose-model',
        apiKey: 'compose-private-provider-key',
        headers: {},
      },
    });
    assert.equal(model.response.status, 201);
    const bot = await request(base + '/bots', {
      cookie,
      method: 'POST',
      body: {
        name: 'Compose Pause Bot',
        roleDescription: 'Pause evidence',
        instructions: 'Use the durable worker.',
        modelBinding: {
          scope: { kind: 'personal', id: login.value.user.id },
          connectionId: model.value.id,
          modelId: 'pause-compose-model',
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
      body: { idempotencyKey: 'pause-queued', body: 'pause-queued' },
    });
    assert.equal(queued.response.status, 202);
    const command = {
      idempotencyKey: 'pause-queued-command',
      expectedRunId: queued.value.task.runs[0].id,
    };
    const paused = await request(`${path}/${queued.value.task.id}/pauses`, {
      cookie,
      method: 'POST',
      body: command,
    });
    assert.equal(paused.response.status, 200);
    assert.equal(paused.value.task.status, 'paused');
    assert.equal(paused.value.task.runs[0].provider, null);
    assert.equal(paused.value.task.runs[0].startedAt, null);
    assert.equal(paused.value.pause.affectedRunCount, 1);
    assert.deepEqual(
      (
        await request(`${path}/${queued.value.task.id}/pauses`, {
          cookie,
          method: 'POST',
          body: command,
        })
      ).value,
      paused.value,
    );
    const zero = await request(`${path}/${queued.value.task.id}/pauses`, {
      cookie,
      method: 'POST',
      body: { ...command, idempotencyKey: 'pause-queued-zero' },
    });
    assert.equal(zero.response.status, 200);
    assert.equal(zero.value.pause.affectedRunCount, 0);
    assert.equal(zero.value.pause.pausedAt, paused.value.pause.pausedAt);
    const running = await request(path, {
      cookie,
      method: 'POST',
      body: { idempotencyKey: 'pause-running', body: 'pause-running' },
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
    const running = await find('pause-running'),
      queued = await find('pause-queued'),
      conversationId = running.conversation_id,
      path = `${base}/conversations/${conversationId}/tasks`,
      webBase = `/app/workspaces/${workspaceId}/conversations/${conversationId}`;
    const read = async (id) => {
      const response = await request(`${path}/${id}`, { cookie });
      assert.equal(response.response.status, 200);
      safe(response.value);
      return response.value.task;
    };
    const partial = async (taskId, runId) => {
      const response = await request(`${path}/${taskId}/runs/${runId}/partial-output`, {
        cookie,
      });
      assert.equal(response.response.status, 200);
      assert.equal(response.response.headers.get('cache-control'), 'private, no-store');
      safe(response.value);
      return response.value;
    };
    if (mode === 'pause') {
      stage = 'separate worker running while API had been stopped';
      await until(async () => (await read(running.id)).status === 'running');
      let task = await read(running.id);
      assert.deepEqual(task.runs[0].provider, {
        protocol: 'openai-chat',
        modelId: 'pause-compose-model',
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
      stage = 'paused durable state independently aborts the active HTTP provider';
      const interrupted = (
        await pool.query(
          'SELECT id,attempt,status,started_at,claim_token,connection_id,model_id,error_code,output_event_id FROM task_runs WHERE id=$1',
          [task.runs[0].id],
        )
      ).rows[0];
      const command = { idempotencyKey: 'pause-running-command', expectedRunId: task.runs[0].id };
      const stopped = await request(`${path}/${task.id}/pauses`, {
        cookie,
        method: 'POST',
        body: command,
      });
      assert.equal(stopped.response.status, 200);
      assert.equal(stopped.value.task.status, 'paused');
      await until(async () =>
        (await stats()).aborted.some((entry) => entry.prompt === 'pause-running'),
      );
      const closed = (await stats()).aborted.find((entry) => entry.prompt === 'pause-running'),
        delay = closed.at - Date.parse(stopped.value.pause.pausedAt);
      assert.ok(
        delay >= 0 && delay <= 1500,
        'responsive database pause must abort the HTTP request within the observation allowance',
      );
      console.info(`task_pause_pause-running_http_abort_ms=${delay}`);
      assert.deepEqual(
        (
          await request(`${path}/${task.id}/pauses`, {
            cookie,
            method: 'POST',
            body: command,
          })
        ).value,
        stopped.value,
      );
      assert.deepEqual((await partial(task.id, task.runs[0].id)).partial, {
        text: prefix,
        endByte: Buffer.byteLength(prefix),
        interrupted: true,
      });
      assert.equal(stopped.value.task.runs[0].output, null);
      await fetch(PROVIDER + '/release', { method: 'POST', signal: AbortSignal.timeout(2000) });
      assert.equal((await stats()).pending, 0);
      stage = 'resume creates one new attempt without mutating the interrupted Run';
      const resumeCommand = {
        idempotencyKey: 'resume-running-command',
        expectedRunId: task.runs[0].id,
      };
      const resumed = await request(`${path}/${task.id}/resumes`, {
        cookie,
        method: 'POST',
        body: resumeCommand,
      });
      assert.equal(resumed.response.status, 202);
      assert.equal(resumed.value.task.status, 'queued');
      assert.equal(resumed.value.task.runCount, 2);
      assert.equal(resumed.value.resume.sourceRunId, task.runs[0].id);
      assert.notEqual(resumed.value.resume.runId, task.runs[0].id);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT id,attempt,status,started_at,claim_token,connection_id,model_id,error_code,output_event_id FROM task_runs WHERE id=$1',
            [task.runs[0].id],
          )
        ).rows[0],
        { ...interrupted, status: 'paused' },
      );
      assert.deepEqual(
        (
          await request(`${path}/${task.id}/resumes`, {
            cookie,
            method: 'POST',
            body: resumeCommand,
          })
        ).value,
        resumed.value,
      );
      const noop = await request(`${path}/${task.id}/resumes`, {
        cookie,
        method: 'POST',
        body: { ...resumeCommand, idempotencyKey: 'resume-running-zero' },
      });
      assert.equal(noop.response.status, 202);
      assert.equal(noop.value.resume.affectedRunCount, 0);
      assert.equal(noop.value.resume.runId, resumed.value.resume.runId);
      await until(async () => (await read(task.id)).status === 'completed');
      assert.deepEqual((await partial(task.id, task.runs[0].id)).partial, {
        text: prefix,
        endByte: Buffer.byteLength(prefix),
        interrupted: true,
      });
      stage = 'same worker processes later independent work';
      const next = await request(path, {
        cookie,
        method: 'POST',
        body: { idempotencyKey: 'pause-after', body: 'pause-after' },
      });
      assert.equal(next.response.status, 202);
      await until(async () => (await read(next.value.task.id)).status === 'completed');
    } else {
      stage = 'restart retains queued pause and interrupted output after resume';
      const stillQueued = await read(queued.id);
      assert.equal(stillQueued.status, 'paused');
      assert.equal(stillQueued.runs[0].status, 'paused');
      assert.equal(stillQueued.runCount, 1);
      const before = await read(running.id);
      assert.equal(before.status, 'completed');
      assert.equal(before.runCount, 2);
      const interruptedId = (
        await pool.query('SELECT id FROM task_runs WHERE task_id=$1 AND status=$2', [
          before.id,
          'paused',
        ])
      ).rows[0].id;
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
      assert.deepEqual((await partial(before.id, interruptedId)).partial, {
        text: prefix,
        endByte: Buffer.byteLength(prefix),
        interrupted: true,
      });
      const bff = await fetch(
        `${WEB}${webBase}/tasks/${before.id}/runs/${interruptedId}/partial-output`,
        { headers: { cookie }, signal: AbortSignal.timeout(10000) },
      );
      assert.equal(bff.status, 200);
      assert.equal(bff.headers.get('cache-control'), 'private, no-store');
      assert.equal(bff.headers.get('set-cookie'), null);
      assert.deepEqual(await bff.json(), await partial(before.id, interruptedId));
      const page = await fetch(`${WEB}${webBase}/tasks/${before.id}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Interrupted output/u);
      assert.match(html, /restart from the original task input/u);
      assert.ok(html.includes(prefix));
      safe(html);
    }
    stage = 'retained counts and exactly one independent final output plus one resumed output';
    const all = (await request(path, { cookie })).value.tasks;
    assert.equal(all.length, 3);
    assert.equal(all.filter((task) => task.status === 'paused').length, 1);
    assert.equal(all.filter((task) => task.status === 'completed').length, 2);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM task_runs')).rows[0].count,
      4,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM task_pause_commands')).rows[0].count,
      3,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM task_resume_commands')).rows[0].count,
      2,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT body FROM conversation_events WHERE event_type='bot.message.created' ORDER BY sequence",
        )
      ).rows,
      [{ body: 'Resumed work completes.' }, { body: 'Independent work completes.' }],
    );
    assert.deepEqual((await stats()).calls, [
      { prompt: 'pause-running', modelId: 'pause-compose-model' },
      { prompt: 'pause-running', modelId: 'pause-compose-model' },
      { prompt: 'pause-after', modelId: 'pause-compose-model' },
    ]);
    assert.equal((await stats()).pending, 0);
    const queuedTask = await read(queued.id);
    assert.equal(queuedTask.status, 'paused');
    assert.equal(queuedTask.runs[0].output, null);
    await assert.rejects(
      pool.query('DELETE FROM task_run_partial_outputs'),
      /canonical completed output/iu,
    );
  }
  console.info(`task_pause_smoke_${mode}_passed`);
} catch {
  console.error(`Task pause Compose smoke failed during ${stage}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

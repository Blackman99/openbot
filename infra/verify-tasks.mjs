import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';

const pool = new pg.Pool();
const mode = process.env.OPENBOT_TASK_SMOKE_STAGE;
const baseUrl = 'http://127.0.0.1:3001';
const credentials = { email: 'task-owner@example.com', password: 'ci-only-task-owner-password' };
let stage = mode;
async function request(path, { cookie, method = 'GET', body, setup = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
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
async function until(check, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await setTimeout(100);
  }
  throw new Error('expected Task state was not reached');
}
const stats = async () =>
  (await fetch('http://task-provider:3100/stats', { signal: AbortSignal.timeout(2000) })).json();
try {
  async function latestTask() {
    return (await pool.query('SELECT * FROM tasks ORDER BY created_at DESC,id DESC LIMIT 1'))
      .rows[0];
  }
  if (mode === 'seed') {
    const setup = await request('/api/v1/setup', {
      method: 'POST',
      setup: true,
      body: { ...credentials, displayName: 'Task owner' },
    });
    assert.equal(setup.response.status, 201);
  }
  const signIn = await request('/api/v1/session', { method: 'POST', body: credentials });
  assert.equal(signIn.response.status, 200);
  const cookie = signIn.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const workspaceId = signIn.value.workspace.id;
  const base = `/api/v1/workspaces/${workspaceId}`;
  if (mode === 'retry-seed' || mode === 'retry-waiting' || mode === 'retry-due') {
    const retryRow = mode === 'retry-seed' ? undefined : await latestTask();
    const retryPath = retryRow
      ? `${base}/conversations/${retryRow.conversation_id}/tasks`
      : undefined;
    const readRetry = async (id) => (await request(`${retryPath}/${id}`, { cookie })).value.task;
    if (mode === 'retry-seed') {
      stage = 'configured fallback and a waiting automatic successor';
      const primary = await request('/api/v1/model-connections', {
        cookie,
        method: 'POST',
        body: {
          name: 'Compose retry primary',
          protocol: 'openai-chat',
          baseUrl: 'http://task-provider:3100/v1',
          modelId: 'compose-model',
          apiKey: 'compose-private-provider-key',
          headers: {},
        },
      });
      assert.equal(primary.response.status, 201);
      const fallback = await request('/api/v1/model-connections', {
        cookie,
        method: 'POST',
        body: {
          name: 'Compose retry fallback',
          protocol: 'openai-chat',
          baseUrl: 'http://task-provider:3100/v1',
          modelId: 'compose-fallback-model',
          apiKey: 'compose-private-provider-key',
          headers: {},
        },
      });
      assert.equal(fallback.response.status, 201);
      const created = await request(`${base}/bots`, {
        cookie,
        method: 'POST',
        body: {
          name: 'Compose retry Bot',
          roleDescription: 'Retry smoke',
          instructions: 'Use the durable worker.',
          modelBinding: {
            scope: { kind: 'personal', id: signIn.value.user.id },
            connectionId: primary.value.id,
            modelId: 'compose-model',
          },
          retryPolicy: { maxAttemptsPerModel: 1, maxRunsPerChain: 4 },
          fallbackBindings: [
            {
              scope: { kind: 'personal', id: signIn.value.user.id },
              connectionId: fallback.value.id,
              modelId: 'compose-fallback-model',
            },
          ],
        },
      });
      assert.equal(created.response.status, 201);
      const opened = await request(`${base}/conversations`, {
        cookie,
        method: 'POST',
        body: { subject: { kind: 'direct-bot', id: created.value.bot.id } },
      });
      assert.equal(opened.response.status, 200);
      const taskPath = `${base}/conversations/${opened.value.conversation.id}/tasks`;
      const submitted = await request(taskPath, {
        cookie,
        method: 'POST',
        body: { idempotencyKey: 'compose-transient', body: 'compose-transient' },
      });
      assert.equal(submitted.response.status, 202);
      await until(async () => {
        const task = (await request(`${taskPath}/${submitted.value.task.id}`, { cookie })).value
          .task;
        return task.status === 'queued' && task.runCount === 2;
      });
      const waiting = (await request(`${taskPath}/${submitted.value.task.id}`, { cookie })).value
        .task;
      assert.equal(waiting.runs[0].status, 'queued');
      assert.equal(waiting.runs[0].provider, null);
      assert.equal(waiting.runs[0].continuation.origin, 'model_fallback');
      assert.equal(waiting.runs[0].continuation.reason, 'provider_unavailable');
      assert.equal(waiting.runs[0].continuation.previousProvider.modelId, 'compose-model');
      assert.equal(waiting.runs[0].continuation.nextProvider.modelId, 'compose-fallback-model');
      assert.equal(waiting.runs[0].continuation.admitted, false);
      const dueAt = Date.parse(waiting.runs[0].continuation.dueAt);
      assert.ok(dueAt - Date.now() > 30_000);
      assert.deepEqual((await stats()).calls, [
        { prompt: 'compose-success', modelId: 'compose-model' },
        { prompt: 'compose-failure', modelId: 'compose-model' },
        { prompt: 'compose-transient', modelId: 'compose-model' },
      ]);
    } else if (mode === 'retry-waiting') {
      stage = 'restart before due does not dispatch the fallback';
      const task = await readRetry(retryRow.id);
      assert.equal(task.status, 'queued');
      assert.equal(task.runCount, 2);
      assert.equal(task.runs[0].continuation.origin, 'model_fallback');
      assert.equal(task.runs[0].continuation.admitted, false);
      assert.equal(task.runs[0].continuation.nextProvider.modelId, 'compose-fallback-model');
      const dueAt = Date.parse(task.runs[0].continuation.dueAt);
      assert.ok(dueAt > Date.now(), 'worker restart exceeded the compose-only notBefore window');
      assert.deepEqual((await stats()).calls, [
        { prompt: 'compose-success', modelId: 'compose-model' },
        { prompt: 'compose-failure', modelId: 'compose-model' },
        { prompt: 'compose-transient', modelId: 'compose-model' },
      ]);
    } else {
      stage = 'due fallback call uses the configured model';
      const dueAt = Date.parse((await readRetry(retryRow.id)).runs[0].continuation.dueAt);
      const waitMs = dueAt - Date.now() + 2000;
      if (waitMs > 0) await setTimeout(waitMs);
      await until(async () => (await readRetry(retryRow.id)).status === 'completed', 150);
      const task = await readRetry(retryRow.id);
      assert.equal(task.runCount, 2);
      assert.equal(task.runs[0].status, 'completed');
      assert.equal(task.runs[0].continuation.origin, 'model_fallback');
      assert.equal(task.runs[0].continuation.admitted, true);
      assert.deepEqual(task.runs[0].provider, {
        protocol: 'openai-chat',
        modelId: 'compose-fallback-model',
      });
      const conversation = await request(
        `${base}/conversations/${retryRow.conversation_id}`,
        { cookie },
      );
      const botOutput = conversation.value.messages.find((message) => message.author.kind === 'bot');
      assert.equal(botOutput.body, 'Fallback after waiting.');
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM tasks')).rows[0].count, 3);
      assert.deepEqual((await stats()).calls, [
        { prompt: 'compose-success', modelId: 'compose-model' },
        { prompt: 'compose-failure', modelId: 'compose-model' },
        { prompt: 'compose-transient', modelId: 'compose-model' },
        { prompt: 'compose-transient', modelId: 'compose-fallback-model' },
      ]);
    }
    console.info(`task_smoke_${mode}_passed`);
    return;
  }
  if (mode === 'seed') {
    stage = 'configured provider and durable submission with idle worker';
    const model = await request('/api/v1/model-connections', {
      cookie,
      method: 'POST',
      body: {
        name: 'Compose provider',
        protocol: 'openai-chat',
        baseUrl: 'http://task-provider:3100/v1',
        modelId: 'compose-model',
        apiKey: 'compose-private-provider-key',
        headers: {},
      },
    });
    assert.equal(model.response.status, 201);
    const created = await request(`${base}/bots`, {
      cookie,
      method: 'POST',
      body: {
        name: 'Compose Task Bot',
        roleDescription: 'Task smoke',
        instructions: 'Use the durable worker.',
        modelBinding: {
          scope: { kind: 'personal', id: signIn.value.user.id },
          connectionId: model.value.id,
          modelId: 'compose-model',
        },
      },
    });
    assert.equal(created.response.status, 201);
    const opened = await request(`${base}/conversations`, {
      cookie,
      method: 'POST',
      body: { subject: { kind: 'direct-bot', id: created.value.bot.id } },
    });
    assert.equal(opened.response.status, 200);
    const taskPath = `${base}/conversations/${opened.value.conversation.id}/tasks`;
    const command = { idempotencyKey: 'compose-success', body: 'compose-success' };
    const submissions = await Promise.all([
      request(taskPath, { cookie, method: 'POST', body: command }),
      request(taskPath, { cookie, method: 'POST', body: command }),
    ]);
    assert.deepEqual(
      submissions.map((entry) => entry.response.status),
      [202, 202],
    );
    assert.deepEqual(submissions[0].value, submissions[1].value);
    await setTimeout(1500);
    const list = await request(taskPath, { cookie });
    assert.equal(list.value.tasks.length, 1);
    assert.equal(list.value.tasks[0].status, 'queued');
    assert.equal(list.value.tasks[0].runs.length, 1);
    assert.equal(list.value.tasks[0].runs[0].provider, null);
    assert.deepEqual((await stats()).calls, []);
  } else {
    const row = (await pool.query('SELECT * FROM tasks ORDER BY created_at,id LIMIT 1')).rows[0];
    assert.ok(row);
    const taskPath = `${base}/conversations/${row.conversation_id}/tasks`;
    const read = async (id = row.id) => (await request(`${taskPath}/${id}`, { cookie })).value.task;
    if (mode === 'running') {
      stage = 'running attempt persisted without API process';
      await until(async () => (await read()).status === 'running');
      const task = await read();
      assert.equal(task.runs[0].attempt, 1);
      assert.deepEqual(task.runs[0].provider, {
        protocol: 'openai-chat',
        modelId: 'compose-model',
      });
      assert.equal(task.runs[0].output, null);
      assert.equal((await stats()).pending, 1);
      await fetch('http://task-provider:3100/release', {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      });
      await until(async () => (await read()).status === 'completed');
      stage = 'failed model call';
      const failed = await request(taskPath, {
        cookie,
        method: 'POST',
        body: { idempotencyKey: 'compose-failure', body: 'compose-failure' },
      });
      assert.equal(failed.response.status, 202);
      await until(async () => (await read(failed.value.task.id)).status === 'failed');
    } else assert.equal(mode, 'reloaded');
    stage = 'persisted Task history and final response';
    const listed = await request(taskPath, { cookie });
    assert.equal(listed.response.headers.get('cache-control'), 'private, no-store');
    assert.equal(listed.value.tasks.length, 2);
    const [success, failed] = listed.value.tasks;
    assert.equal(success.status, 'completed');
    assert.equal(success.runs[0].status, 'completed');
    assert.deepEqual(success.runs[0].usage, { inputTokens: 7, outputTokens: 3 });
    assert.ok(success.runs[0].output);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.runs[0].error, 'provider_failed');
    assert.equal(failed.runs[0].output, null);
    assert.equal(failed.runs[0].attempt, 1);
    assert.deepEqual(failed.runs[0].provider, {
      protocol: 'openai-chat',
      modelId: 'compose-model',
    });
    const conversation = await request(`${base}/conversations/${row.conversation_id}`, { cookie });
    assert.equal(conversation.value.messages.length, 3);
    const botOutput = conversation.value.messages.find((message) => message.author.kind === 'bot');
    assert.equal(botOutput.body, 'Persisted separate worker response.');
    assert.equal(botOutput.author.versionId, success.bot.versionId);
    assert.equal(botOutput.canEdit, false);
    assert.equal(botOutput.canDelete, false);
    assert.equal(botOutput.canAudit, false);
    assert.doesNotMatch(
      JSON.stringify([listed.value, conversation.value]),
      /private-provider-key|private upstream|Unpublished partial|sealed|claim_token/iu,
    );
    assert.deepEqual((await stats()).calls, [
      { prompt: 'compose-success', modelId: 'compose-model' },
      { prompt: 'compose-failure', modelId: 'compose-model' },
    ]);
    const repeated = await request(taskPath, {
      cookie,
      method: 'POST',
      body: { idempotencyKey: 'compose-success', body: 'compose-success' },
    });
    assert.equal(repeated.value.task.id, success.id);
    assert.equal(repeated.value.task.status, 'completed');
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS count FROM task_runs')).rows[0].count,
      2,
    );
    for (const table of ['tasks', 'task_runs']) {
      await assert.rejects(pool.query(`DELETE FROM ${table}`), /permission denied/iu);
      await assert.rejects(
        pool.query(`UPDATE ${table} SET created_at=NOW()`),
        /permission denied/iu,
      );
    }
  }
  console.info(`task_smoke_${mode}_passed`);
} catch {
  console.error(`Task Compose smoke failed during ${stage}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

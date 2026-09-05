import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import {
  encodeConversationStreamCursor,
  encodeConversationStreamEvent,
  parseConversationStreamCursor,
} from './dist/conversations/stream-protocol.js';

// Run through stdin in the Compose API container (/app), using its runtime role.
// running precedes verify-tasks running; reloaded follows verify-tasks reloaded.
const FRAME_BYTES = 256 * 1024;
const QUEUE_BYTES = 512 * 1024;
const JSON_BYTES = 1024 * 1024;
const FIRST_TEXT = 'Persisted ';
const FINAL_TEXT = 'Persisted separate worker response.';
const API = 'http://127.0.0.1:3001';
const WEB = 'http://web:3000';
const PROVIDER = 'http://task-provider:3100';
function uuid(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  return value;
}
function safe(value) {
  assert.doesNotMatch(
    JSON.stringify(value),
    /private-provider-key|private upstream|sealed|claim_token|authorization|password|api[_-]?key/iu,
  );
}
function privateResponse(response, type) {
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    new RegExp(`^${type}(?:;\\s*charset=utf-8)?$`, 'iu'),
  );
  assert.equal(response.headers.get('cache-control'), 'private, no-store, no-transform');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('set-cookie'), null);
}
async function json(response, limit = JSON_BYTES) {
  assert.match(
    response.headers.get('content-type') ?? '',
    /^application\/json(?:;\s*charset=utf-8)?$/iu,
  );
  const advertised = response.headers.get('content-length');
  if (advertised !== null) {
    assert.match(advertised, /^\d+$/u);
    assert.ok(Number(advertised) <= limit);
  }
  assert.ok(response.body);
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      assert.ok(item.value.byteLength > 0 && size <= limit);
      chunks.push(item.value);
    }
    assert.ok(size > 0);
    if (advertised !== null) assert.equal(size, Number(advertised));
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// The real BFF emits LF and one JSON data line. Its production codec owns the
// general SSE/DTO validation; this extractor checks the deployed frame identity
// against the actual API encoder and retains only a bounded incomplete frame.
function frame(bytes, scope) {
  assert.ok(bytes.length <= FRAME_BYTES);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -2).split('\n');
  if (lines.every((line) => line.startsWith(':'))) return;
  const fields = {};
  for (const line of lines) {
    const match = /^(id|event|data): (.*)$/u.exec(line);
    assert.ok(match && !Object.hasOwn(fields, match[1]));
    fields[match[1]] = match[2];
  }
  assert.equal(Object.keys(fields).sort().join(','), 'data,event,id');
  const value = JSON.parse(fields.data);
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
  assert.equal(parseConversationStreamCursor(fields.id, scope)?.after, value.sequence);
  assert.equal(value.cursor, fields.id);
  assert.equal(value.type, fields.event);
  const encoded = encodeConversationStreamEvent(scope, value.sequence, new Date(value.occurredAt), {
    type: value.type,
    data: value.data,
  });
  assert.deepEqual(value, JSON.parse(encoded.match(/^data: (.+)$/mu)[1]));
  safe(value);
  return value;
}
async function readEvents(url, cookie, scope, after, through, signal) {
  const transport = new AbortController();
  let reader;
  try {
    const response = await fetch(url, {
      headers: {
        cookie,
        accept: 'text/event-stream',
        'last-event-id': encodeConversationStreamCursor(scope, after),
      },
      redirect: 'error',
      signal: AbortSignal.any([signal, transport.signal, AbortSignal.timeout(20_000)]),
    });
    privateResponse(response, 'text/event-stream');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.ok(response.body);
    reader = response.body.getReader();
    const events = [];
    let pending = Buffer.alloc(0),
      size = 0,
      acknowledged = after;
    while (acknowledged < through) {
      const item = await reader.read();
      assert.equal(item.done, false);
      size += item.value.byteLength;
      assert.ok(item.value.byteLength > 0 && size <= 2 * JSON_BYTES);
      assert.ok(pending.length + item.value.byteLength <= QUEUE_BYTES);
      pending = Buffer.concat([pending, item.value]);
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const value = frame(pending.subarray(0, end + 2), scope);
        pending = pending.subarray(end + 2);
        if (!value) continue; // Data-free connected/heartbeat comments never ack.
        assert.equal(value.sequence, acknowledged + 1);
        assert.ok(value.sequence <= through && events.length < 64);
        acknowledged = value.sequence;
        events.push(value);
      }
      assert.ok(pending.length <= FRAME_BYTES);
    }
    return events;
  } finally {
    // Cancel only this delivery transport, never the Task or provider request.
    transport.abort();
    await reader?.cancel().catch(() => {});
  }
}
function matchExecution(value, task) {
  assert.equal(value.taskId, task.task_id);
  assert.equal(value.runId, task.run_id);
  assert.equal(value.attempt, 1);
  assert.equal(value.bot.id, task.bot_id);
  assert.equal(value.bot.versionId, task.bot_version_id);
  assert.equal(value.bot.displayName, 'Compose Task Bot');
  assert.deepEqual(value.executionUser, { id: task.execution_user_id, displayName: 'Task owner' });
  assert.equal(value.taskStatus, value.runStatus);
  assert.deepEqual(
    value.provider,
    value.runStatus === 'queued' ? null : { protocol: 'openai-chat', modelId: 'compose-model' },
  );
  if (value.runStatus === 'queued' || value.runStatus === 'running') {
    assert.equal(value.output, null);
    assert.equal(value.error, null);
  }
}

async function main() {
  let pool,
    stage = 'configuration';
  try {
    const mode = process.env.OPENBOT_STREAM_SMOKE_STAGE;
    assert.ok(mode === 'running' || mode === 'reloaded');
    const signal = AbortSignal.timeout(45_000);
    const request = (url, options = {}) =>
      fetch(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
    pool = new pg.Pool({
      max: 1,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
      application_name: 'openbot_stream_compose_smoke',
    });
    const query = async (...args) => (await pool.query(...args)).rows;
    stage = 'runtime role and current session';
    assert.deepEqual(
      await query(
        'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      ),
      [{ name: 'openbot_runtime', rolsuper: false, rolbypassrls: false }],
    );
    const login = await request(`${API}/api/v1/session`, {
      method: 'POST',
      headers: { origin: process.env.WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'task-owner@example.com',
        password: 'ci-only-task-owner-password',
      }),
    });
    assert.equal(login.status, 200);
    const identity = await json(login),
      cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.match(cookie ?? '', /^openbot_session=[A-Za-z0-9_-]{43}$/u);
    const workspaceId = uuid(identity.workspace.id),
      actorId = uuid(identity.user.id);
    const loadTask = async (key = 'compose-success') => {
      const rows = await query(
        `SELECT t.id AS task_id,t.workspace_id,t.conversation_id,t.bot_id,t.bot_version_id,t.execution_user_id,t.status AS task_status,
          r.id AS run_id,r.attempt,r.status AS run_status,r.output_event_id,r.protocol,r.model_id
         FROM tasks t JOIN conversation_events e ON e.id=t.trigger_event_id JOIN task_runs r ON r.task_id=t.id
         WHERE t.workspace_id=$1 AND t.execution_user_id=$2 AND e.idempotency_key=$3 ORDER BY r.attempt`,
        [workspaceId, actorId, key],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].attempt, 1);
      return rows[0];
    };
    const task = await loadTask(),
      scope = { workspaceId, conversationId: uuid(task.conversation_id) };
    const url = `${WEB}/app/workspaces/${workspaceId}/conversations/${scope.conversationId}/events`;
    const stats = async () => {
      const response = await request(`${PROVIDER}/stats`);
      assert.equal(response.status, 200);
      return json(response, 4096);
    };
    const held = async () => {
      assert.deepEqual(await loadTask(), task);
      assert.equal(task.task_status, 'running');
      assert.equal(task.run_status, 'running');
      assert.equal(task.output_event_id, null);
      assert.deepEqual(await stats(), {
        calls: [{ prompt: 'compose-success', modelId: 'compose-model' }],
        pending: 1,
      });
      assert.equal(
        (
          await query(
            'SELECT COUNT(*)::int AS count FROM conversation_events WHERE bot_run_id=$1',
            [task.run_id],
          )
        )[0].count,
        0,
      );
    };
    stage = 'committed first delta and BFF bootstrap';
    let first;
    const deadline = Date.now() + 15_000;
    do {
      signal.throwIfAborted();
      first = (
        await query(
          "SELECT sequence,start_byte,end_byte,delta_text FROM conversation_delivery_events WHERE conversation_id=$1 AND run_id=$2 AND event_type='assistant.delta' AND start_byte=0 ORDER BY sequence LIMIT 1",
          [scope.conversationId, task.run_id],
        )
      )[0];
      if (!first) await pause(100, undefined, { signal });
    } while (!first && Date.now() < deadline);
    assert.ok(first);
    const firstSequence = Number(first.sequence);
    assert.ok(Number.isSafeInteger(firstSequence) && firstSequence > 0);
    assert.equal(first.delta_text, FIRST_TEXT);
    assert.equal(first.start_byte, 0);
    assert.equal(first.end_byte, Buffer.byteLength(FIRST_TEXT));
    const readBootstrap = async () => {
      const response = await request(`${url}/bootstrap`, { headers: { cookie } });
      privateResponse(response, 'application/json');
      const value = await json(response);
      assert.equal(value.schemaVersion, 1);
      assert.equal(value.conversationId, scope.conversationId);
      assert.ok(parseConversationStreamCursor(value.cursor, scope));
      assert.equal(value.nextMessageCursor, null);
      assert.equal(value.nextTaskCursor, null);
      assert.equal(value.previewsTruncated, false);
      safe(value);
      return value;
    };
    const snapshot = await readBootstrap(),
      horizon = parseConversationStreamCursor(snapshot.cursor, scope).after;
    const projected = snapshot.executions.find((item) => item.runId === task.run_id);
    assert.ok(projected);
    matchExecution(projected, task);
    if (mode === 'running') {
      stage = 'first delta before completion through BFF';
      await held();
      assert.equal(projected.runStatus, 'running');
      assert.equal(snapshot.executions.length, 1);
      assert.equal(snapshot.messages.length, 1);
      assert.equal(horizon, firstSequence);
      const preview = {
        taskId: task.task_id,
        runId: task.run_id,
        attempt: 1,
        endByte: first.end_byte,
        text: FIRST_TEXT,
      };
      assert.deepEqual(snapshot.previews, [preview]);
      const events = await readEvents(url, cookie, scope, 0, firstSequence, signal);
      assert.deepEqual(
        events.map((item) => item.type),
        ['message.changed', 'task.run.updated', 'task.run.updated', 'assistant.delta'],
      );
      assert.deepEqual(events[0].data.message, snapshot.messages[0]);
      assert.deepEqual(
        events.slice(1, 3).map((item) => item.data.execution.runStatus),
        ['queued', 'running'],
      );
      for (const item of events.slice(1, 3)) matchExecution(item.data.execution, task);
      assert.deepEqual(events.at(-1).data, { ...preview, startByte: 0 });
      stage = 'transport cancellation preserves the same live worker call';
      await held();
      assert.deepEqual(await readBootstrap(), snapshot);
      await held();
    } else {
      stage = 'resume acknowledged delta after process restart';
      assert.equal(task.task_status, 'completed');
      assert.equal(task.run_status, 'completed');
      assert.equal(projected.runStatus, 'completed');
      assert.equal(snapshot.executions.length, 2);
      assert.equal(snapshot.messages.length, 3);
      assert.deepEqual(snapshot.previews, []);
      const failed = await loadTask('compose-failure');
      assert.equal(failed.conversation_id, scope.conversationId);
      assert.equal(failed.run_status, 'failed');
      const events = await readEvents(url, cookie, scope, firstSequence, horizon, signal);
      assert.equal(events[0].sequence, firstSequence + 1);
      const states = events
        .filter((item) => item.type === 'task.run.updated')
        .map((item) => item.data.execution);
      assert.deepEqual(
        states.map((item) => [item.runId, item.runStatus]),
        [
          [task.run_id, 'completed'],
          [failed.run_id, 'queued'],
          [failed.run_id, 'running'],
          [failed.run_id, 'failed'],
        ],
      );
      for (const state of states)
        matchExecution(state, state.runId === task.run_id ? task : failed);
      const deltas = events.filter(
        (item) => item.type === 'assistant.delta' && item.data.runId === task.run_id,
      );
      assert.ok(deltas.length > 0);
      let prefix = FIRST_TEXT,
        offset = first.end_byte;
      for (const item of deltas) {
        assert.equal(item.data.taskId, task.task_id);
        assert.equal(item.data.attempt, 1);
        assert.equal(item.data.startByte, offset);
        prefix += item.data.text;
        offset = item.data.endByte;
      }
      assert.equal(prefix, FINAL_TEXT);
      assert.equal(offset, Buffer.byteLength(FINAL_TEXT));
      stage = 'one final ledger answer through the current BFF locator';
      const outputs = await query(
        "SELECT id,message_id,sequence,body,bot_run_id,event_data,occurred_at FROM conversation_events WHERE conversation_id=$1 AND event_type='bot.message.created' ORDER BY sequence",
        [scope.conversationId],
      );
      assert.equal(outputs.length, 1);
      const output = outputs[0];
      assert.equal(output.bot_run_id, task.run_id);
      assert.equal(output.id, task.output_event_id);
      assert.equal(output.body, FINAL_TEXT);
      const references = events.filter(
        (item) =>
          item.type === 'message.changed' && item.data.message.messageId === output.message_id,
      );
      assert.equal(references.length, 1);
      assert.deepEqual(references[0].data.message, {
        messageId: output.message_id,
        creationSequence: Number(output.sequence),
        versionEventId: output.id,
        sequence: Number(output.sequence),
        deleted: false,
        taskId: task.task_id,
        runId: task.run_id,
      });
      assert.ok(deltas.at(-1).sequence < references[0].sequence);
      assert.ok(
        references[0].sequence < events.find((item) => item.type === 'task.run.updated').sequence,
      );
      assert.deepEqual(states[0], projected);
      assert.deepEqual(projected.output, {
        messageId: output.message_id,
        eventId: output.id,
        sequence: Number(output.sequence),
      });
      assert.deepEqual(projected.usage, { inputTokens: 7, outputTokens: 3 });
      assert.equal(states.at(-1).error, 'provider_failed');
      assert.equal(states.at(-1).output, null);
      assert.deepEqual(
        states.at(-1),
        snapshot.executions.find((item) => item.runId === failed.run_id),
      );
      const locator = await request(`${url}/messages/${uuid(output.message_id)}`, {
        headers: { cookie },
      });
      privateResponse(locator, 'application/json');
      const value = await json(locator);
      assert.deepEqual(value, {
        message: {
          id: output.message_id,
          creationSequence: Number(output.sequence),
          versionEventId: output.id,
          sequence: Number(output.sequence),
          version: 1,
          author: { kind: 'bot', ...output.event_data.bot },
          body: FINAL_TEXT,
          reason: null,
          deleted: false,
          createdAt: output.occurred_at.toISOString(),
          updatedAt: output.occurred_at.toISOString(),
          canEdit: false,
          canDelete: false,
          canAudit: false,
        },
      });
      safe(value);
      assert.deepEqual(await stats(), {
        calls: [
          { prompt: 'compose-success', modelId: 'compose-model' },
          { prompt: 'compose-failure', modelId: 'compose-model' },
        ],
        pending: 0,
      });
      const durable = await query(
        'SELECT sequence,event_type FROM conversation_delivery_events WHERE conversation_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence',
        [scope.conversationId, firstSequence, horizon],
      );
      assert.deepEqual(
        events.map((item) => ({ sequence: item.sequence, type: item.type })),
        durable.map((item) => ({ sequence: Number(item.sequence), type: item.event_type })),
      );
      assert.equal(
        (
          await query(
            'SELECT COUNT(*)::int AS count FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.conversation_id=$1',
            [scope.conversationId],
          )
        )[0].count,
        2,
      );
    }
    console.info(`conversation_stream_smoke_${mode}_passed`);
  } catch {
    // No response bodies, cookies, credentials, or raw provider diagnostics.
    console.error(`Conversation stream Compose smoke failed during ${stage}`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}

await main();

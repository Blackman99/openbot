import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TaskQueue, TaskPublicationError } from '../../src/tasks/queue.js';
import { TaskService } from '../../src/tasks/service.js';
import { reclaimConversationStream } from '../../src/conversations/stream-retention.js';
import { taskFixture } from '../helpers/task-fixture.js';
import { installTaskCancellationFixture } from '../helpers/task-cancellation-fixture.js';
import { randomUUID } from 'node:crypto';

describe('cancelled Run partial output', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('retains the committed UTF-8 prefix after cancellation, service reconstruction and feed expiry', async () => {
    const f = await taskFixture(cleanup);
    await installTaskCancellationFixture(f.pool);
    const queue = new TaskQueue(f.pool);
    const { claim } = await queue.claimNext();
    expect(claim).toBeDefined();
    await queue.publishDelta(claim!, 'First 🌲');
    await queue.publishDelta(claim!, '\n已提交的前缀');
    const prefix = 'First 🌲\n已提交的前缀';
    await f.tasks.cancel(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id, {
      idempotencyKey: 'stop-with-prefix',
      expectedRunId: claim!.runId,
    });
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      await reclaimConversationStream(
        connection,
        f.conversation.id,
        new Date(Date.now() + 86400001),
      );
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
    expect((await f.pool.query('SELECT sequence FROM conversation_delivery_events')).rows).toEqual(
      [],
    );
    const app = buildApp({
      auth: f.auth,
      tasks: new TaskService(f.pool),
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const url = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}/runs/${claim!.runId}/partial-output`;
    const response = await app.inject({ method: 'GET', url, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      conversationId: f.conversation.id,
      taskId: f.task.id,
      runId: claim!.runId,
      partial: { text: prefix, endByte: Buffer.byteLength(prefix), interrupted: true },
    });
    await expect(queue.publishDelta(claim!, 'LATE')).rejects.toBeInstanceOf(TaskPublicationError);
    await expect(
      queue.finish(claim!, { body: 'LATE FINAL', usage: { inputTokens: 1, outputTokens: 2 } }),
    ).resolves.toBe(false);
    expect((await app.inject({ method: 'GET', url, headers: f.headers })).json()).toEqual(
      response.json(),
    );
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toEqual([]);
    expect((await f.read()).runs[0]).toMatchObject({
      status: 'cancelled',
      usage: null,
      error: null,
      output: null,
    });
  });

  it('reads only cancelled Runs in the currently inspectable exact conversation and preserves valid sessions on denial', async () => {
    const f = await taskFixture(cleanup);
    await installTaskCancellationFixture(f.pool);
    const app = buildApp({
      auth: f.auth,
      tasks: f.tasks,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const base = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}/runs/`;
    const url = base + f.task.runs[0]!.id + '/partial-output';
    expect((await app.inject({ method: 'GET', url, headers: f.headers })).statusCode).toBe(409);
    await f.tasks.cancel(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id, {
      idempotencyKey: 'stop-empty',
      expectedRunId: f.task.runs[0]!.id,
    });
    expect((await app.inject({ method: 'GET', url, headers: f.headers })).json()).toMatchObject({
      partial: null,
    });
    expect(
      (await app.inject({ method: 'GET', url: url + '?body=true', headers: f.headers })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: base + randomUUID() + '/partial-output',
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const other = await f.addUser();
    const denied = await app.inject({ method: 'GET', url, headers: other.headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(denied.json())).not.toContain(
      'Instructions visible only with a direct Bot grant.',
    );
  });
});

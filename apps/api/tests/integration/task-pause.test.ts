import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { taskFixture } from '../helpers/task-fixture.js';
import {
  groupCancellationFixture,
  installTaskCancellationFixture,
} from '../helpers/task-cancellation-fixture.js';
import { createQueuedTaskChild } from '../helpers/task-tree-fixture.js';
import { TaskQueue, type TaskClaim } from '../../src/tasks/queue.js';
import { TaskService } from '../../src/tasks/service.js';
import { writeNextAttempt } from '../../src/tasks/next-attempt.js';
import { planManualResume } from '../../src/tasks/resume.js';
import { randomUUID } from 'node:crypto';

describe('COL-08 Task pause and resume', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function fixture() {
    const f = await taskFixture(cleanup);
    await installTaskCancellationFixture(f.pool);
    const app = buildApp({
      auth: f.auth,
      tasks: f.tasks,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const url = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}/pauses`;
    const command = { idempotencyKey: 'pause-once', expectedRunId: f.task.runs[0]!.id };
    return {
      ...f,
      app,
      url,
      command,
      post: (payload: unknown = command, headers = f.headers) =>
        app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: JSON.stringify(payload),
        }),
    };
  }

  it('pauses a queued Task through the API, holds no execution slot, and remains paused after restart', async () => {
    const f = await fixture();
    const response = await f.post();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      task: {
        id: f.task.id,
        status: 'paused',
        runs: [
          {
            id: f.task.runs[0]!.id,
            status: 'paused',
            startedAt: null,
            provider: null,
            usage: null,
            error: null,
            output: null,
          },
        ],
      },
      pause: {
        commandId: expect.any(String),
        taskId: f.task.id,
        rootTaskId: f.task.id,
        runId: f.task.runs[0]!.id,
        attempt: 1,
        checkpointId: expect.any(String),
        pausedAt: expect.any(String),
        affectedTaskCount: 1,
        affectedRunCount: 1,
      },
    });
    expect(
      (
        await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.command })
      ).json(),
    ).toEqual(response.json());
    let calls = 0;
    await expect(
      f
        .worker(async () => {
          calls++;
          throw new Error('must not call provider');
        })
        .runOnce(),
    ).resolves.toBe(false);
    expect(calls).toBe(0);

    const restarted = new TaskService(f.pool);
    const persisted = await restarted.get(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      f.task.id,
    );
    expect(persisted).toMatchObject({
      id: f.task.id,
      status: 'paused',
      runs: [{ id: f.task.runs[0]!.id, status: 'paused' }],
    });
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(1);
    expect(
      (await f.pool.query("SELECT id FROM audit_events WHERE event_type='task.paused'")).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          'SELECT strategy,schema_version,end_byte FROM task_run_pause_checkpoints WHERE run_id=$1',
          [f.task.runs[0]!.id],
        )
      ).rows,
    ).toEqual([{ strategy: 'restart_from_task_input_v1', schema_version: 1, end_byte: 0 }]);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('replays the same pause key and treats a new key as a zero-effect receipt', async () => {
    const f = await fixture();
    const first = await f.post();
    const before = (await f.pool.query('SELECT * FROM task_runs')).rows;
    expect(first.statusCode).toBe(200);
    const changed = await f.post({ ...f.command, expectedRunId: randomUUID() });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: { code: 'idempotency_conflict' } });
    const stale = await f.post({ idempotencyKey: 'stale-view', expectedRunId: randomUUID() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: { code: 'task_pause_run_conflict' } });
    const noop = await f.post({ ...f.command, idempotencyKey: 'already-paused' });
    expect(noop.statusCode).toBe(200);
    expect(noop.json()).toMatchObject({
      task: first.json().task,
      pause: {
        pausedAt: first.json().pause.pausedAt,
        checkpointId: first.json().pause.checkpointId,
        affectedTaskCount: 0,
        affectedRunCount: 0,
      },
    });
    expect((await f.pool.query('SELECT * FROM task_runs')).rows).toEqual(before);
    expect((await f.pool.query('SELECT id FROM task_pause_commands')).rows).toHaveLength(2);
    expect((await f.pool.query('SELECT id FROM task_run_pause_checkpoints')).rows).toHaveLength(1);
  });

  it('resumes a paused queued Task through the single next-attempt writer without mutating the interrupted Run', async () => {
    const f = await fixture();
    const paused = await f.post();
    expect(paused.statusCode).toBe(200);
    const interrupted = (
      await f.pool.query(
        'SELECT id,attempt,status,finished_at,error_code FROM task_runs WHERE id=$1',
        [f.task.runs[0]!.id],
      )
    ).rows[0];
    const now = new Date('2026-09-06T00:10:00.000Z');
    const connection = await f.pool.connect();
    let first: Awaited<ReturnType<typeof writeNextAttempt>>;
    try {
      await connection.query('BEGIN');
      first = await writeNextAttempt(connection, {
        taskId: f.task.id,
        sourceRunId: interrupted.id,
        workspaceId: f.owner.workspace.id,
        conversationId: f.conversation.id,
        executionUserId: f.owner.user.id,
        sourceAttempt: 1,
        plan: planManualResume({
          binding: {
            scope: { kind: 'personal', id: f.owner.user.id },
            connectionId: f.model.id,
            modelId: f.model.modelId,
          },
          sourceRunId: interrupted.id,
          chainRootRunId: interrupted.id,
          chainAttemptOrdinal: 2,
          chainLimitSnapshot: 4,
          now,
        }),
        now,
      });
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
    expect(first).toMatchObject({ scheduled: true, runId: expect.any(String) });
    const runs = (
      await f.pool.query(
        'SELECT id,attempt,status,finished_at,error_code FROM task_runs WHERE task_id=$1 ORDER BY attempt',
        [f.task.id],
      )
    ).rows;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(interrupted);
    expect(runs[1]).toMatchObject({ attempt: 2, status: 'queued', error_code: null });
    expect((await f.read()).status).toBe('queued');
    const queuedAudit = (
      await f.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'runId'=$1",
        [runs[1]!.id],
      )
    ).rows[0]!.metadata;
    expect(queuedAudit).toMatchObject({
      origin: 'manual_resume',
      sourceRunId: interrupted.id,
      previousRunId: interrupted.id,
    });
    const replay = await f.pool.connect();
    try {
      await replay.query('BEGIN');
      expect(
        await writeNextAttempt(replay, {
          taskId: f.task.id,
          sourceRunId: interrupted.id,
          workspaceId: f.owner.workspace.id,
          conversationId: f.conversation.id,
          executionUserId: f.owner.user.id,
          sourceAttempt: 1,
          plan: planManualResume({
            binding: {
              scope: { kind: 'personal', id: f.owner.user.id },
              connectionId: f.model.id,
              modelId: f.model.modelId,
            },
            sourceRunId: interrupted.id,
            chainRootRunId: interrupted.id,
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
      (await f.pool.query('SELECT id FROM task_runs WHERE task_id=$1', [f.task.id])).rows,
    ).toHaveLength(2);
    expect(
      (
        await f.pool.query(
          'SELECT id,attempt,status,finished_at,error_code FROM task_runs WHERE id=$1',
          [interrupted.id],
        )
      ).rows[0],
    ).toEqual(interrupted);
  });

  it('pauses a running Task, drops its claim, and keeps the same Run', async () => {
    const f = await fixture();
    const queue = new TaskQueue(f.pool);
    const claimed = await queue.claimNext();
    expect(claimed.claim?.runId).toBe(f.task.runs[0]!.id);
    await queue.publishDelta(claimed.claim!, 'Visible prefix 🌿');
    const response = await f.post();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      task: {
        id: f.task.id,
        status: 'paused',
        runs: [
          {
            id: f.task.runs[0]!.id,
            status: 'paused',
            startedAt: expect.any(String),
            provider: { protocol: expect.any(String), modelId: expect.any(String) },
            usage: null,
            error: null,
            output: null,
          },
        ],
      },
      pause: {
        runId: f.task.runs[0]!.id,
        attempt: 1,
        affectedTaskCount: 1,
        affectedRunCount: 1,
      },
    });
    expect(await queue.isClaimActive(claimed.claim!)).toBe(false);
    expect(await queue.finish(claimed.claim!, { body: 'Late answer', usage: null })).toBe(false);
    expect((await f.pool.query('SELECT id,status FROM task_runs')).rows).toEqual([
      { id: f.task.runs[0]!.id, status: 'paused' },
    ]);
    expect(
      (
        await f.pool.query('SELECT end_byte FROM task_run_pause_checkpoints WHERE run_id=$1', [
          f.task.runs[0]!.id,
        ])
      ).rows,
    ).toEqual([{ end_byte: Buffer.byteLength('Visible prefix 🌿') }]);
    expect(
      await f.tasks.partialOutput(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        f.task.id,
        f.task.runs[0]!.id,
      ),
    ).toMatchObject({
      partial: { text: 'Visible prefix 🌿', interrupted: true },
    });
    const restarted = new TaskService(f.pool);
    expect(
      await restarted.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, f.task.id),
    ).toMatchObject({
      status: 'paused',
      runs: [{ id: f.task.runs[0]!.id, status: 'paused' }],
    });
    let calls = 0;
    await expect(
      f
        .worker(async () => {
          calls++;
          throw new Error('must not call provider');
        })
        .runOnce(),
    ).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it('resumes a paused Task as a new queued attempt without mutating the interrupted Run', async () => {
    const f = await fixture();
    const paused = await f.post();
    expect(paused.statusCode).toBe(200);
    const before = (await f.pool.query('SELECT * FROM task_runs')).rows;
    const url = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}/resumes`;
    const command = { idempotencyKey: 'resume-once', expectedRunId: f.task.runs[0]!.id };
    const post = (payload: unknown = command) =>
      f.app.inject({
        method: 'POST',
        url,
        headers: { ...f.headers, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    const response = await post();
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.task).toMatchObject({
      id: f.task.id,
      status: 'queued',
      runCount: 2,
      runs: [{ status: 'queued', attempt: 2 }],
    });
    expect(body.resume).toMatchObject({
      taskId: f.task.id,
      sourceRunId: f.task.runs[0]!.id,
      attempt: 2,
      checkpointId: paused.json().pause.checkpointId,
      affectedTaskCount: 1,
      affectedRunCount: 1,
    });
    expect(body.resume.runId).not.toBe(f.task.runs[0]!.id);
    expect(body.task.runs[0]!.id).toBe(body.resume.runId);
    expect(
      (await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [f.task.runs[0]!.id])).rows,
    ).toEqual(before);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { ...f.headers, 'content-type': 'application/json' },
          payload: JSON.stringify(command),
        })
      ).json(),
    ).toEqual(body);
    const stale = await post({ idempotencyKey: 'stale-resume', expectedRunId: randomUUID() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: { code: 'task_resume_run_conflict' } });
    const noop = await post({ ...command, idempotencyKey: 'already-resumed' });
    expect(noop.statusCode).toBe(202);
    expect(noop.json()).toMatchObject({
      task: body.task,
      resume: {
        runId: body.resume.runId,
        sourceRunId: f.task.runs[0]!.id,
        checkpointId: body.resume.checkpointId,
        resumedAt: body.resume.resumedAt,
        affectedTaskCount: 0,
        affectedRunCount: 0,
      },
    });
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(2);
    let calls = 0;
    await expect(
      f
        .worker(async () => {
          calls++;
          return {
            events: [
              { type: 'text', text: 'Resumed answer' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        })
        .runOnce(),
    ).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(
      await new TaskService(f.pool).get(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        f.task.id,
      ),
    ).toMatchObject({
      status: 'completed',
      runCount: 2,
      runs: [{ id: body.resume.runId, status: 'completed', attempt: 2 }],
    });
    expect(
      (await f.pool.query('SELECT status FROM task_runs WHERE id=$1', [f.task.runs[0]!.id])).rows,
    ).toEqual([{ status: 'paused' }]);
  });

  it('pauses a subtree and resumes only the selected Task', async () => {
    const f = await groupCancellationFixture(cleanup);
    const input = {
      workspaceId: f.owner.workspace.id,
      conversationId: f.grant.conversationId,
      executionUserId: f.member.id,
      botId: f.sharedBot.id,
      botVersionId: f.sharedBot.currentVersion!.id,
      groupGrantId: f.grant.id,
      parentTaskId: f.groupTask.id,
    };
    const child = await createQueuedTaskChild(f.pool, input);
    const queue = new TaskQueue(f.pool);
    const claims = new Map<string, TaskClaim>();
    while (true) {
      const next = await queue.claimNext();
      if (!next.handled) break;
      if (next.claim) claims.set(next.claim.taskId, next.claim);
    }
    expect(claims.has(f.groupTask.id)).toBe(true);
    expect(claims.has(child.id)).toBe(true);
    const app = buildApp({
      auth: f.auth,
      tasks: f.tasks,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const headers = { ...f.member.headers, 'content-type': 'application/json' };
    const pauseUrl = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.grant.conversationId}/tasks/${f.groupTask.id}/pauses`;
    const paused = await app.inject({
      method: 'POST',
      url: pauseUrl,
      headers,
      payload: JSON.stringify({
        idempotencyKey: 'pause-tree',
        expectedRunId: f.groupTask.runs[0]!.id,
      }),
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().pause).toMatchObject({ affectedTaskCount: 2, affectedRunCount: 2 });
    expect(await queue.isClaimActive(claims.get(f.groupTask.id)!)).toBe(false);
    expect(await queue.isClaimActive(claims.get(child.id)!)).toBe(false);
    expect(
      (
        await f.pool.query('SELECT status FROM tasks WHERE id=$1 OR id=$2 ORDER BY id', [
          f.groupTask.id,
          child.id,
        ])
      ).rows.map((row) => row.status),
    ).toEqual(['paused', 'paused']);
    const adminResume = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.grant.conversationId}/tasks/${f.groupTask.id}/resumes`,
      headers: { ...f.admin.headers, 'content-type': 'application/json' },
      payload: JSON.stringify({
        idempotencyKey: 'admin-resume',
        expectedRunId: f.groupTask.runs[0]!.id,
      }),
    });
    expect(adminResume.statusCode).toBe(403);
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.grant.conversationId}/tasks/${f.groupTask.id}/resumes`,
      headers,
      payload: JSON.stringify({
        idempotencyKey: 'resume-root',
        expectedRunId: f.groupTask.runs[0]!.id,
      }),
    });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({
      task: { id: f.groupTask.id, status: 'queued', runCount: 2 },
      resume: { sourceRunId: f.groupTask.runs[0]!.id, attempt: 2, affectedTaskCount: 1 },
    });
    expect((await f.pool.query('SELECT status FROM tasks WHERE id=$1', [child.id])).rows).toEqual([
      { status: 'paused' },
    ]);
    expect(
      (await f.pool.query('SELECT status FROM task_runs WHERE id=$1', [child.runId])).rows,
    ).toEqual([{ status: 'paused' }]);
    const childResume = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.grant.conversationId}/tasks/${child.id}/resumes`,
      headers,
      payload: JSON.stringify({
        idempotencyKey: 'resume-child',
        expectedRunId: child.runId,
      }),
    });
    expect(childResume.statusCode).toBe(202);
    expect(childResume.json()).toMatchObject({
      task: { id: child.id, status: 'queued', runCount: 2 },
      resume: { sourceRunId: child.runId, attempt: 2 },
    });
  }, 15000);
});

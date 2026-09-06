import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { taskFixture } from '../helpers/task-fixture.js';
import { installTaskCancellationFixture } from '../helpers/task-cancellation-fixture.js';
import { TaskService } from '../../src/tasks/service.js';
import { writeNextAttempt } from '../../src/tasks/next-attempt.js';
import { planManualResume } from '../../src/tasks/resume.js';
import { randomUUID } from 'node:crypto';

describe('COL-08 queued Task pause first slice', () => {
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
});

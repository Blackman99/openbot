import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { taskFixture } from '../helpers/task-fixture.js';
import {
  groupCancellationFixture,
  installTaskCancellationFixture,
} from '../helpers/task-cancellation-fixture.js';
import { randomUUID } from 'node:crypto';
import { BotLifecycleService } from '../../src/bots/lifecycle-service.js';

describe('explicit Task cancellation', () => {
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
    const url = `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${f.conversation.id}/tasks/${f.task.id}/cancellations`;
    const command = { idempotencyKey: 'stop-once', expectedRunId: f.task.runs[0]!.id };
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

  it('cancels a queued Task once and never contacts its provider', async () => {
    const f = await fixture();
    const request = {
      method: 'POST' as const,
      url: f.url,
      headers: f.headers,
      payload: { idempotencyKey: 'stop-once', expectedRunId: f.task.runs[0]!.id },
    };
    const response = await f.app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      task: {
        id: f.task.id,
        status: 'cancelled',
        runs: [
          {
            status: 'cancelled',
            startedAt: null,
            provider: null,
            usage: null,
            error: null,
            output: null,
          },
        ],
      },
      receipt: {
        commandId: expect.any(String),
        taskId: f.task.id,
        rootTaskId: f.task.id,
        runId: f.task.runs[0]!.id,
        attempt: 1,
        cancelledAt: expect.any(String),
        affectedTaskCount: 1,
        affectedRunCount: 1,
      },
    });
    expect((await f.app.inject(request)).json()).toEqual(response.json());
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
    expect((await f.pool.query('SELECT id FROM task_runs')).rows).toHaveLength(1);
    expect(
      (await f.pool.query("SELECT id FROM audit_events WHERE event_type='task.cancelled'")).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE event_type='bot.message.created'",
        )
      ).rows,
    ).toHaveLength(0);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('retains the exact receipt on replay and makes a new cancellation key a zero-effect receipt', async () => {
    const f = await fixture();
    const first = await f.post();
    const before = (await f.pool.query('SELECT * FROM task_runs')).rows;
    expect(first.statusCode).toBe(200);
    const changed = await f.post({ ...f.command, expectedRunId: randomUUID() });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: { code: 'idempotency_conflict' } });
    const stale = await f.post({ idempotencyKey: 'stale-view', expectedRunId: randomUUID() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: { code: 'task_cancel_run_conflict' } });
    const noop = await f.post({ ...f.command, idempotencyKey: 'already-stopped' });
    expect(noop.statusCode).toBe(200);
    expect(noop.json()).toMatchObject({
      task: first.json().task,
      receipt: {
        cancelledAt: first.json().receipt.cancelledAt,
        affectedTaskCount: 0,
        affectedRunCount: 0,
      },
    });
    expect((await f.post()).json()).toEqual(first.json());
    expect((await f.pool.query('SELECT * FROM task_runs')).rows).toEqual(before);
    expect((await f.pool.query('SELECT id FROM task_cancel_commands')).rows).toHaveLength(2);
    expect((await f.pool.query('SELECT run_id FROM task_run_cancellations')).rows).toHaveLength(1);
    expect(
      (await f.pool.query("SELECT id FROM audit_events WHERE event_type='task.cancelled'")).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT run_id FROM task_run_delivery_receipts WHERE run_status='cancelled'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('stops with current inspection after provider-use permission is lost', async () => {
    const f = await fixture();
    await f.providers.disable(f.owner.user.id, f.model.id);
    const response = await f.post();
    expect(response.statusCode).toBe(200);
    expect(response.json().task.status).toBe('cancelled');
    expect((await f.post()).json()).toEqual(response.json());
    expect(response.body).not.toMatch(/never-return|sealed|claim_token|connectionId|instructions/u);
  });

  it('rejects forged or stale authority without mutating work or clearing a valid identity', async () => {
    const f = await fixture();
    for (const input of [
      null,
      [],
      {},
      { ...f.command, actorUserId: f.owner.user.id },
      { ...f.command, groupGrantId: randomUUID() },
      { ...f.command, body: 'replacement prompt' },
      { ...f.command, expectedRunId: 'invalid' },
      { ...f.command, idempotencyKey: '' },
      { ...f.command, idempotencyKey: 'contains space' },
      { ...f.command, idempotencyKey: 'x'.repeat(129) },
    ]) {
      const response = await f.post(input);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: 'invalid_task_request' } });
    }
    const stranger = await f.addUser('administrator');
    const forbidden = await f.post(f.command, stranger.headers);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.headers['set-cookie']).toBeUndefined();
    expect(
      await f.auth.getSession(stranger.headers.cookie.slice('openbot_session='.length)),
    ).toBeDefined();
    expect(
      (await f.post(f.command, { ...f.headers, origin: 'https://elsewhere.example' })).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: f.url,
          headers: { origin: f.headers.origin },
          payload: f.command,
        })
      ).statusCode,
    ).toBe(401);
    expect((await f.pool.query('SELECT id FROM task_cancel_commands')).rows).toHaveLength(0);
    expect((await f.read()).status).toBe('queued');
  });

  it.each(['completed', 'failed'] as const)(
    'preserves terminal %s history and declines a fresh cancellation',
    async (outcome) => {
      const f = await fixture();
      await f
        .worker(async () => {
          if (outcome === 'failed') throw new Error('provider failed');
          return {
            events: [
              { type: 'text', text: 'Saved answer' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        })
        .runOnce();
      const before = await f.read();
      expect(before.status).toBe(outcome);
      const response = await f.post();
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: { code: 'task_cancel_state_conflict' } });
      expect(await f.read()).toEqual(before);
      expect((await f.pool.query('SELECT id FROM task_cancel_commands')).rows).toHaveLength(0);
    },
  );

  it.each(['execution-human', 'owner', 'admin'] as const)(
    'lets the current group %s stop work after the grant, provider and Bot become unavailable',
    async (role) => {
      const f = await groupCancellationFixture(cleanup);
      const actor =
        role === 'execution-human'
          ? f.member
          : role === 'owner'
            ? { id: f.owner.user.id, headers: f.headers }
            : f.admin;
      await f.grants.remove(f.owner.user.id, f.owner.workspace.id, f.group.id, f.grant.id, {
        idempotencyKey: 'close-before-stop',
      });
      await f.providers
        .inWorkspace(f.owner.workspace.id)
        .disable(f.owner.user.id, f.sharedProvider.id);
      await new BotLifecycleService(f.pool).archive(
        f.owner.user.id,
        f.owner.workspace.id,
        f.sharedBot.id,
      );
      const result = await f.tasks.cancel(
        actor.id,
        f.owner.workspace.id,
        f.grant.conversationId,
        f.groupTask.id,
        {
          idempotencyKey: 'moderated-stop',
          expectedRunId: f.groupTask.runs[0]!.id,
        },
      );
      expect(result.task).toMatchObject({
        status: 'cancelled',
        executionUser: { id: f.member.id },
        groupGrantId: f.grant.id,
      });
      expect(result.receipt).toMatchObject({ affectedTaskCount: 1, affectedRunCount: 1 });
      expect(
        (
          await f.pool.query(
            "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='task.cancelled'",
          )
        ).rows,
      ).toMatchObject([
        {
          actor_user_id: actor.id,
          metadata: { taskId: f.groupTask.id, runId: f.groupTask.runs[0]!.id },
        },
      ]);
      expect(
        (
          await f.pool.query('SELECT role FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
            f.sharedBot.id,
            f.member.id,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(JSON.stringify(result)).not.toMatch(
        /cancellation-provider-secret|Private cancellation|claim_token|sealed|connectionId/u,
      );
    },
  );

  it('reauthorizes a group receipt and denies an unrelated member or a removed moderator', async () => {
    const f = await groupCancellationFixture(cleanup);
    const command = { idempotencyKey: 'moderated-stop', expectedRunId: f.groupTask.runs[0]!.id };
    const cancel = (actorId: string) =>
      f.tasks.cancel(
        actorId,
        f.owner.workspace.id,
        f.grant.conversationId,
        f.groupTask.id,
        command,
      );
    await expect(cancel(f.otherMember.id)).rejects.toThrow();
    const workspaceOnly = await f.addUser('administrator');
    await expect(cancel(workspaceOnly.id)).rejects.toThrow();
    expect((await f.pool.query('SELECT id FROM task_cancel_commands')).rows).toHaveLength(0);
    const result = await cancel(f.admin.id);
    await f.groups.changeRole(f.owner.user.id, f.owner.workspace.id, f.group.id, f.admin.id, {
      role: 'member',
    });
    await expect(cancel(f.admin.id)).rejects.toThrow();
    await f.groups.removeMember(f.owner.user.id, f.owner.workspace.id, f.group.id, f.member.id);
    await expect(cancel(f.member.id)).rejects.toThrow();
    expect((await f.pool.query('SELECT id FROM task_cancel_commands')).rows).toEqual([
      { id: result.receipt.commandId },
    ]);
  });
});

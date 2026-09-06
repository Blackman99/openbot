import { afterEach, expect, it } from 'vitest';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { publicTaskFixture } from '../helpers/public-task-fixture.js';
import { createQueuedTaskChild } from '../helpers/task-tree-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('submits one durable group task through tasks:write with Idempotency-Key', async () => {
  const f = await publicTaskFixture(cleanup);
  const headers = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...headers, 'idempotency-key': 'public-task-1' },
    payload: { groupId, prompt: 'Summarize the evidence.', leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  expect(created.headers['cache-control']).toBe('private, no-store');
  expect(created.headers['x-content-type-options']).toBe('nosniff');
  const task = created.json().task;
  expect(task).toMatchObject({
    id: expect.any(String),
    groupId,
    conversationId: expect.any(String),
    status: 'queued',
    leadGrantId,
    bot: { id: f.bot.id },
    executionUser: { id: f.owner.user.id },
    runs: [{ id: expect.any(String), attempt: 1, status: 'queued' }],
  });
  const ui = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${task.conversationId}/tasks/${task.id}`,
    headers: f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task).toMatchObject({
    id: task.id,
    status: 'queued',
    groupGrantId: leadGrantId,
    bot: { id: f.bot.id },
    runs: [{ id: task.runs[0].id, attempt: 1, status: 'queued' }],
  });
});

it('replays the same Idempotency-Key without creating another run', async () => {
  const f = await publicTaskFixture(cleanup);
  const headers = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const payload = { groupId, prompt: 'Summarize the evidence.', leadGrantId };
  const submit = () =>
    f.publicApp.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { ...headers, 'idempotency-key': 'replay-once' },
      payload,
    });
  const first = await submit();
  expect(first.statusCode).toBe(202);
  const second = await submit();
  expect(second.statusCode).toBe(202);
  expect(second.json()).toEqual(first.json());
  const listed = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${first.json().task.conversationId}/tasks`,
    headers: f.headers,
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().tasks).toHaveLength(1);
  expect(listed.json().tasks[0].runs).toHaveLength(1);
});

it('rejects a reused Idempotency-Key with a different body and leaves the original task unchanged', async () => {
  const f = await publicTaskFixture(cleanup);
  const headers = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const first = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...headers, 'idempotency-key': 'conflict-key' },
    payload: { groupId, prompt: 'Original prompt.', leadGrantId },
  });
  expect(first.statusCode).toBe(202);
  const original = first.json().task;
  const conflicted = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...headers, 'idempotency-key': 'conflict-key' },
    payload: { groupId, prompt: 'Changed prompt.', leadGrantId },
  });
  expect(conflicted.statusCode).toBe(409);
  expect(conflicted.json()).toEqual({ error: { code: 'idempotency_conflict' } });
  const ui = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${original.conversationId}/tasks/${original.id}`,
    headers: f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task).toMatchObject({
    id: original.id,
    status: 'queued',
    runs: [{ id: original.runs[0].id, attempt: 1 }],
  });
  expect(ui.json().task.trigger).toMatchObject({ messageId: expect.any(String) });
  const events = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${original.conversationId}?limit=10`,
    headers: f.headers,
  });
  expect(events.statusCode).toBe(200);
  const bodies = events
    .json()
    .messages.map((message: { body: string | null }) => message.body)
    .filter(Boolean);
  expect(bodies).toContain('Original prompt.');
  expect(bodies).not.toContain('Changed prompt.');
});

it('denies submit without tasks:write or without group access', async () => {
  const f = await publicTaskFixture(cleanup);
  const writeHeaders = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const readOnly = await f.bearer(['tasks:read']);
  const missingScope = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...readOnly, 'idempotency-key': 'denied-scope' },
    payload: { groupId, prompt: 'Should not submit.', leadGrantId },
  });
  expect(missingScope.statusCode).toBe(403);
  expect(missingScope.json()).toEqual({ error: { code: 'insufficient_scope' } });
  const outsider = await f.addUser();
  const outsiderHeaders = await f.bearer(['tasks:write'], outsider.id);
  const noGroup = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...outsiderHeaders, 'idempotency-key': 'denied-group' },
    payload: { groupId, prompt: 'Should not submit.', leadGrantId },
  });
  expect(noGroup.statusCode).toBe(403);
  expect(noGroup.json()).toEqual({ error: { code: 'task_forbidden' } });
  const listed = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${
      (
        await f.conversations.open(f.owner.user.id, f.owner.workspace.id, {
          subject: { kind: 'group', id: groupId },
        })
      ).id
    }/tasks`,
    headers: f.headers,
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().tasks).toHaveLength(0);
});

it('retrieves status, delegation tree, budget consumption, and confirmed results', async () => {
  const f = await publicTaskFixture(cleanup);
  const writeHeaders = await f.bearer(['tasks:write']);
  const readHeaders = await f.bearer(['tasks:read']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...writeHeaders, 'idempotency-key': 'retrieve-me' },
    payload: { groupId, prompt: 'Summarize the evidence.', leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  const submitted = created.json().task;
  const child = await createQueuedTaskChild(f.pool, {
    workspaceId: f.owner.workspace.id,
    conversationId: submitted.conversationId,
    executionUserId: f.owner.user.id,
    botId: f.bot.id,
    botVersionId: f.bot.currentVersion!.id,
    groupGrantId: leadGrantId,
    parentTaskId: submitted.id,
  });
  const worker = new TaskWorker(f.pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async (_input, _signal, onEvent) => {
        const events = [
          { type: 'text' as const, text: 'Confirmed public result.' },
          { type: 'usage' as const, inputTokens: 4, outputTokens: 3 },
          { type: 'complete' as const, stopReason: 'stop' as const },
        ];
        for (const event of events) await onEvent?.(event);
        return { events, raw: 'private' };
      },
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  const retrieved = await f.publicApp.inject({
    method: 'GET',
    url: `/v1/tasks/${submitted.id}`,
    headers: readHeaders,
  });
  expect(retrieved.statusCode).toBe(200);
  expect(retrieved.headers['cache-control']).toBe('private, no-store');
  expect(retrieved.headers['x-content-type-options']).toBe('nosniff');
  const task = retrieved.json().task;
  expect(task).toMatchObject({
    id: submitted.id,
    groupId,
    conversationId: submitted.conversationId,
    status: 'completed',
    leadGrantId,
    tokenBudgets: [
      expect.objectContaining({
        kind: 'run',
        used: expect.objectContaining({
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
          totalTokens: expect.any(Number),
        }),
      }),
    ],
    delegationTree: {
      rootTaskId: submitted.id,
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: submitted.id,
          parentTaskId: null,
          depth: 0,
          status: 'completed',
        }),
        expect.objectContaining({
          id: child.id,
          parentTaskId: submitted.id,
          depth: 1,
          status: 'queued',
        }),
      ]),
    },
    confirmedResults: [
      expect.objectContaining({
        runId: submitted.runs[0].id,
        attempt: 1,
        body: 'Confirmed public result.',
        messageId: expect.any(String),
        eventId: expect.any(String),
        sequence: expect.any(Number),
      }),
    ],
  });
  expect(task.delegationTree.nodes).toHaveLength(2);
});

it('cancels an unfinished task and remains idempotent on replay', async () => {
  const f = await publicTaskFixture(cleanup);
  const headers = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...headers, 'idempotency-key': 'cancel-me' },
    payload: { groupId, prompt: 'Stop this work.', leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  const submitted = created.json().task;
  const command = {
    idempotencyKey: 'public-cancel-once',
    expectedRunId: submitted.runs[0].id,
  };
  const first = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/tasks/${submitted.id}/cancellations`,
    headers,
    payload: command,
  });
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('private, no-store');
  expect(first.json()).toMatchObject({
    task: {
      id: submitted.id,
      groupId,
      status: 'cancelled',
      runs: [{ id: submitted.runs[0].id, status: 'cancelled' }],
    },
    receipt: {
      commandId: expect.any(String),
      taskId: submitted.id,
      rootTaskId: submitted.id,
      runId: submitted.runs[0].id,
      attempt: 1,
      cancelledAt: expect.any(String),
      affectedTaskCount: 1,
      affectedRunCount: 1,
    },
  });
  const replay = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/tasks/${submitted.id}/cancellations`,
    headers,
    payload: command,
  });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(first.json());
  const ui = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${submitted.conversationId}/tasks/${submitted.id}`,
    headers: f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task.status).toBe('cancelled');
});

it('denies cancel without tasks:write or without group access', async () => {
  const f = await publicTaskFixture(cleanup);
  const writeHeaders = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...writeHeaders, 'idempotency-key': 'deny-cancel' },
    payload: { groupId, prompt: 'Protected task.', leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  const submitted = created.json().task;
  const command = {
    idempotencyKey: 'denied-cancel',
    expectedRunId: submitted.runs[0].id,
  };
  const readOnly = await f.bearer(['tasks:read']);
  const missingScope = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/tasks/${submitted.id}/cancellations`,
    headers: readOnly,
    payload: command,
  });
  expect(missingScope.statusCode).toBe(403);
  expect(missingScope.json()).toEqual({ error: { code: 'insufficient_scope' } });
  const outsider = await f.addUser();
  const outsiderHeaders = await f.bearer(['tasks:write'], outsider.id);
  const noGroup = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/tasks/${submitted.id}/cancellations`,
    headers: outsiderHeaders,
    payload: command,
  });
  expect(noGroup.statusCode).toBe(403);
  expect(noGroup.json()).toEqual({ error: { code: 'task_forbidden' } });
  const ui = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${submitted.conversationId}/tasks/${submitted.id}`,
    headers: f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task.status).toBe('queued');
});

it('retries a failed task into a new run while preserving the prior run, error, and audit', async () => {
  const f = await publicTaskFixture(cleanup);
  const headers = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...headers, 'idempotency-key': 'retry-me' },
    payload: { groupId, prompt: 'Retry this failure.', leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  const submitted = created.json().task;
  const worker = new TaskWorker(f.pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async () => {
        throw new Error('provider failed');
      },
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  const failed = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${submitted.conversationId}/tasks/${submitted.id}`,
    headers: f.headers,
  });
  expect(failed.statusCode).toBe(200);
  expect(failed.json().task).toMatchObject({
    status: 'failed',
    runs: [{ id: submitted.runs[0].id, attempt: 1, status: 'failed', error: 'provider_failed' }],
  });
  const priorRun = (
    await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [submitted.runs[0].id])
  ).rows[0];
  const retried = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/tasks/${submitted.id}/retries`,
    headers: { ...headers, 'idempotency-key': 'public-retry-1' },
    payload: { expectedRunId: submitted.runs[0].id },
  });
  expect(retried.statusCode).toBe(202);
  expect(retried.headers['cache-control']).toBe('private, no-store');
  expect(retried.headers['x-content-type-options']).toBe('nosniff');
  expect(retried.json()).toMatchObject({
    task: {
      id: submitted.id,
      groupId,
      status: 'queued',
      runCount: 2,
      runs: [{ id: expect.any(String), attempt: 2, status: 'queued', error: null }],
    },
    receipt: { runId: expect.any(String), attempt: 2 },
  });
  expect(retried.json().receipt.runId).toBe(retried.json().task.runs[0].id);
  expect(retried.json().task.runs).toHaveLength(1);
  expect(
    (await f.pool.query('SELECT * FROM task_runs WHERE id=$1', [submitted.runs[0].id])).rows[0],
  ).toEqual(priorRun);
  const audits = (
    await f.pool.query(
      "SELECT actor_user_id,occurred_at,metadata FROM audit_events WHERE event_type='task.retried' AND metadata->>'taskId'=$1",
      [submitted.id],
    )
  ).rows;
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor_user_id: f.owner.user.id,
    occurred_at: expect.any(Date),
  });
  expect(audits[0].metadata).toMatchObject({
    taskId: submitted.id,
    previousRunId: submitted.runs[0].id,
    runId: retried.json().receipt.runId,
    attempt: 2,
  });
  expect(JSON.stringify(audits[0].metadata)).not.toMatch(/Bearer|sk-|secret/i);
  const ui = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${submitted.conversationId}/tasks/${submitted.id}`,
    headers: f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task).toMatchObject({
    status: 'queued',
    runCount: 2,
    runs: [{ id: retried.json().receipt.runId, attempt: 2, status: 'queued' }],
  });
  const history = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${submitted.conversationId}/tasks/${submitted.id}/runs`,
    headers: f.headers,
  });
  expect(history.statusCode).toBe(200);
  expect(history.json().runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: retried.json().receipt.runId,
        attempt: 2,
        status: 'queued',
      }),
      expect.objectContaining({
        id: submitted.runs[0].id,
        attempt: 1,
        status: 'failed',
        error: 'provider_failed',
      }),
    ]),
  );
});

it('replays the same Idempotency-Key retry without creating another run', async () => {
  const f = await publicTaskFixture(cleanup);
  const headers = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...headers, 'idempotency-key': 'retry-replay-source' },
    payload: { groupId, prompt: 'Retry once.', leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  const submitted = created.json().task;
  const worker = new TaskWorker(f.pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async () => {
        throw new Error('provider failed');
      },
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  const retry = () =>
    f.publicApp.inject({
      method: 'POST',
      url: `/v1/tasks/${submitted.id}/retries`,
      headers: { ...headers, 'idempotency-key': 'public-retry-replay' },
      payload: { expectedRunId: submitted.runs[0].id },
    });
  const first = await retry();
  expect(first.statusCode).toBe(202);
  const second = await retry();
  expect(second.statusCode).toBe(202);
  expect(second.json()).toEqual(first.json());
  expect(
    (await f.pool.query('SELECT id FROM task_runs WHERE task_id=$1', [submitted.id])).rows,
  ).toHaveLength(2);
  expect(
    (await f.pool.query('SELECT id FROM task_retry_commands WHERE task_id=$1', [submitted.id]))
      .rows,
  ).toHaveLength(1);
});

it('denies retry without tasks:write or without group access', async () => {
  const f = await publicTaskFixture(cleanup);
  const writeHeaders = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...writeHeaders, 'idempotency-key': 'deny-retry-source' },
    payload: { groupId, prompt: 'Protected retry.', leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  const submitted = created.json().task;
  const worker = new TaskWorker(f.pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async () => {
        throw new Error('provider failed');
      },
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  const command = { expectedRunId: submitted.runs[0].id };
  const readOnly = await f.bearer(['tasks:read']);
  const missingScope = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/tasks/${submitted.id}/retries`,
    headers: { ...readOnly, 'idempotency-key': 'denied-retry-scope' },
    payload: command,
  });
  expect(missingScope.statusCode).toBe(403);
  expect(missingScope.json()).toEqual({ error: { code: 'insufficient_scope' } });
  const outsider = await f.addUser();
  const outsiderHeaders = await f.bearer(['tasks:write'], outsider.id);
  const noGroup = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/tasks/${submitted.id}/retries`,
    headers: { ...outsiderHeaders, 'idempotency-key': 'denied-retry-group' },
    payload: command,
  });
  expect(noGroup.statusCode).toBe(403);
  expect(noGroup.json()).toEqual({ error: { code: 'task_forbidden' } });
  const ui = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${submitted.conversationId}/tasks/${submitted.id}`,
    headers: f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task).toMatchObject({
    status: 'failed',
    runCount: 1,
    runs: [{ id: submitted.runs[0].id, attempt: 1, status: 'failed' }],
  });
});

async function parkPublicApproval(
  cleanup: Array<() => Promise<unknown>>,
  prompt = 'Draft the announcement.',
  summary = 'Send the announcement.',
) {
  const f = await publicTaskFixture(cleanup, { actionSupported: true });
  const writeHeaders = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...writeHeaders, 'idempotency-key': `approval-source-${prompt.length}` },
    payload: { groupId, prompt, leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  const submitted = created.json().task;
  const worker = new TaskWorker(f.pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async () => ({
        events: [
          {
            type: 'action',
            id: 'call-1',
            name: 'request_approval',
            arguments: { summary },
          },
          { type: 'complete', stopReason: 'tool_calls' },
        ],
        raw: '',
      }),
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  const ui = await f.sessionApp.inject({
    url: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${submitted.conversationId}/tasks/${submitted.id}`,
    headers: f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task).toMatchObject({
    status: 'waiting_approval',
    humanRequest: { kind: 'approval', summary, id: expect.any(String) },
  });
  return {
    f,
    groupId,
    submitted,
    approvalId: ui.json().task.humanRequest.id as string,
    summary,
  };
}

it('lists and retrieves pending approvals for tasks:approve group members', async () => {
  const parked = await parkPublicApproval(cleanup);
  const headers = await parked.f.bearer(['tasks:approve']);
  const listed = await parked.f.publicApp.inject({ url: '/v1/approvals', headers });
  expect(listed.statusCode).toBe(200);
  expect(listed.headers['cache-control']).toBe('private, no-store');
  expect(listed.json()).toEqual({
    approvals: [
      {
        id: parked.approvalId,
        taskId: parked.submitted.id,
        groupId: parked.groupId,
        conversationId: parked.submitted.conversationId,
        status: 'pending',
        summary: parked.summary,
        createdAt: expect.any(String),
      },
    ],
  });
  const got = await parked.f.publicApp.inject({
    url: `/v1/approvals/${parked.approvalId}`,
    headers,
  });
  expect(got.statusCode).toBe(200);
  expect(got.json()).toEqual({ approval: listed.json().approvals[0] });
});

it('lets tasks:approve resolve an approval and records actor, timestamp, and task ref without token plaintext', async () => {
  const parked = await parkPublicApproval(cleanup, 'Approve this draft.', 'Publish the draft.');
  const headers = await parked.f.bearer(['tasks:approve']);
  const decided = await parked.f.publicApp.inject({
    method: 'POST',
    url: `/v1/approvals/${parked.approvalId}/decisions`,
    headers: { ...headers, 'idempotency-key': 'public-approve-1' },
    payload: { decision: 'approve' },
  });
  expect(decided.statusCode).toBe(202);
  expect(decided.headers['cache-control']).toBe('private, no-store');
  expect(decided.headers['x-content-type-options']).toBe('nosniff');
  expect(decided.json()).toMatchObject({
    approval: {
      id: parked.approvalId,
      taskId: parked.submitted.id,
      groupId: parked.groupId,
      status: 'approved',
      summary: parked.summary,
      decision: 'approve',
      decidedAt: expect.any(String),
    },
    task: {
      id: parked.submitted.id,
      groupId: parked.groupId,
      status: 'queued',
      runCount: 2,
      runs: [{ id: expect.any(String), attempt: 2, status: 'queued' }],
    },
    receipt: {
      requestId: parked.approvalId,
      runId: expect.any(String),
      attempt: 2,
      decidedAt: expect.any(String),
    },
  });
  expect(decided.json().receipt.runId).toBe(decided.json().task.runs[0].id);
  const audits = (
    await parked.f.pool.query(
      "SELECT actor_user_id,occurred_at,metadata FROM audit_events WHERE event_type='task.human.decided' AND metadata->>'taskId'=$1",
      [parked.submitted.id],
    )
  ).rows;
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor_user_id: parked.f.owner.user.id,
    occurred_at: expect.any(Date),
  });
  expect(audits[0].metadata).toMatchObject({
    taskId: parked.submitted.id,
    requestId: parked.approvalId,
    decision: 'approve',
  });
  expect(JSON.stringify(audits[0].metadata)).not.toMatch(/Bearer|sk-|secret/i);
  const ui = await parked.f.sessionApp.inject({
    url: `/api/v1/workspaces/${parked.f.owner.workspace.id}/conversations/${parked.submitted.conversationId}/tasks/${parked.submitted.id}`,
    headers: parked.f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task).toMatchObject({
    status: 'queued',
    runCount: 2,
  });
  expect(ui.json().task.humanRequest).toBeUndefined();
});

it('replays the same approval decision and rejects the opposite with 409', async () => {
  const parked = await parkPublicApproval(cleanup, 'Need a decision.', 'Ship the release.');
  const headers = await parked.f.bearer(['tasks:approve']);
  const first = await parked.f.publicApp.inject({
    method: 'POST',
    url: `/v1/approvals/${parked.approvalId}/decisions`,
    headers: { ...headers, 'idempotency-key': 'approve-once' },
    payload: { decision: 'approve' },
  });
  expect(first.statusCode).toBe(202);
  const replay = await parked.f.publicApp.inject({
    method: 'POST',
    url: `/v1/approvals/${parked.approvalId}/decisions`,
    headers: { ...headers, 'idempotency-key': 'approve-again' },
    payload: { decision: 'approve' },
  });
  expect(replay.statusCode).toBe(202);
  expect(replay.json()).toEqual(first.json());
  const opposite = await parked.f.publicApp.inject({
    method: 'POST',
    url: `/v1/approvals/${parked.approvalId}/decisions`,
    headers: { ...headers, 'idempotency-key': 'reject-instead' },
    payload: { decision: 'reject' },
  });
  expect(opposite.statusCode).toBe(409);
  expect(opposite.json()).toEqual({ error: { code: 'idempotency_conflict' } });
  expect(
    (await parked.f.pool.query('SELECT id FROM task_runs WHERE task_id=$1', [parked.submitted.id]))
      .rows,
  ).toHaveLength(2);
});

it('denies approval resolve without tasks:approve or without group membership', async () => {
  const parked = await parkPublicApproval(cleanup, 'Protected approval.', 'Hold for review.');
  const readOnly = await parked.f.bearer(['tasks:read']);
  const missingScope = await parked.f.publicApp.inject({
    method: 'POST',
    url: `/v1/approvals/${parked.approvalId}/decisions`,
    headers: { ...readOnly, 'idempotency-key': 'denied-approve-scope' },
    payload: { decision: 'approve' },
  });
  expect(missingScope.statusCode).toBe(403);
  expect(missingScope.json()).toEqual({ error: { code: 'insufficient_scope' } });
  const outsider = await parked.f.addUser();
  const outsiderHeaders = await parked.f.bearer(['tasks:approve'], outsider.id);
  const noGroup = await parked.f.publicApp.inject({
    method: 'POST',
    url: `/v1/approvals/${parked.approvalId}/decisions`,
    headers: { ...outsiderHeaders, 'idempotency-key': 'denied-approve-group' },
    payload: { decision: 'approve' },
  });
  expect(noGroup.statusCode).toBe(403);
  expect(noGroup.json()).toEqual({ error: { code: 'task_forbidden' } });
  const ui = await parked.f.sessionApp.inject({
    url: `/api/v1/workspaces/${parked.f.owner.workspace.id}/conversations/${parked.submitted.conversationId}/tasks/${parked.submitted.id}`,
    headers: parked.f.headers,
  });
  expect(ui.statusCode).toBe(200);
  expect(ui.json().task).toMatchObject({
    status: 'waiting_approval',
    humanRequest: { id: parked.approvalId, kind: 'approval' },
  });
});

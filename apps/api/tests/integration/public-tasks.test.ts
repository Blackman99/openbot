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

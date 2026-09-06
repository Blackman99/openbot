import { afterEach, expect, it } from 'vitest';
import { publicTaskFixture } from '../helpers/public-task-fixture.js';

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

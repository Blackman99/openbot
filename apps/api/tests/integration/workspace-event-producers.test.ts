import { afterEach, expect, it } from 'vitest';
import { TaskQueue } from '../../src/tasks/queue.js';
import { publicTaskFixture } from '../helpers/public-task-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('publishes cancellation and terminal workspace events from domain transitions', async () => {
  const f = await publicTaskFixture(cleanup);
  const headers = await f.bearer(['tasks:write']);
  const { groupId, leadGrantId } = await f.readyGroup();
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...headers, 'idempotency-key': 'workspace-event-producer' },
    payload: { groupId, prompt: 'Publish me', leadGrantId },
  });
  expect(created.statusCode).toBe(202);
  const taskId = created.json().task.id as string;
  const queue = new TaskQueue(f.pool);
  const claim = (await queue.claimNext()).claim!;
  await queue.finish(claim, { body: 'Done', usage: null });
  const cancelled = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { ...headers, 'idempotency-key': 'workspace-event-cancel' },
    payload: { groupId, prompt: 'Cancel me', leadGrantId },
  });
  expect(cancelled.statusCode).toBe(202);
  const cancelId = cancelled.json().task.id as string;
  const expectedRunId = cancelled.json().task.runs[0].id as string;
  const stop = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/tasks/${cancelId}/cancellations`,
    headers,
    payload: { idempotencyKey: 'cancel-1', expectedRunId },
  });
  expect(stop.statusCode).toBe(200);
  const rows = (
    await f.pool.query(
      'SELECT event_type, payload FROM workspace_events WHERE workspace_id=$1 ORDER BY sequence',
      [f.owner.workspace.id],
    )
  ).rows;
  expect(
    rows.some((row) => row.event_type === 'task.terminal' && row.payload.taskId === taskId),
  ).toBe(true);
  expect(
    rows.some((row) => row.event_type === 'task.cancelled' && row.payload.taskId === cancelId),
  ).toBe(true);
  expect(rows.every((row) => row.payload.groupId === groupId)).toBe(true);
});

import { afterEach, expect, it } from 'vitest';
import { groupCancellationFixture } from '../helpers/task-cancellation-fixture.js';
import { createQueuedTaskChild } from '../helpers/task-tree-fixture.js';
import { TaskQueue, type TaskClaim } from '../../src/tasks/queue.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('cancels through terminal intermediates, retains siblings and fences a failed descendant retry', async () => {
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
  const middle = await createQueuedTaskChild(f.pool, input);
  const leaf = await createQueuedTaskChild(f.pool, { ...input, parentTaskId: middle.id });
  const failed = await createQueuedTaskChild(f.pool, input);
  const unrelated = await f.tasks.submit(
    f.member.id,
    f.owner.workspace.id,
    f.grant.conversationId,
    { idempotencyKey: 'unrelated-root', body: 'Unrelated work', groupGrantId: f.grant.id },
  );
  const queue = new TaskQueue(f.pool),
    claims = new Map<string, TaskClaim>();
  while (true) {
    const next = await queue.claimNext();
    if (!next.handled) break;
    if (next.claim) claims.set(next.claim.taskId, next.claim);
  }
  await queue.finish(claims.get(middle.id)!, { body: 'Already completed child', usage: null });
  await queue.finish(claims.get(failed.id)!, { error: 'provider_failed', usage: null });
  const retryKey = { idempotencyKey: 'retained-retry', expectedRunId: failed.runId };
  const retried = await f.tasks.retry(
    f.member.id,
    f.owner.workspace.id,
    f.grant.conversationId,
    failed.id,
    retryKey,
  );
  const retryClaim = (await queue.claimNext()).claim!;
  expect(retryClaim.taskId).toBe(failed.id);
  await queue.finish(retryClaim, { error: 'provider_failed', usage: null });
  const terminalBefore = (
    await f.pool.query('SELECT * FROM task_runs WHERE task_id=$1 OR task_id=$2 ORDER BY id', [
      middle.id,
      failed.id,
    ])
  ).rows;
  await queue.publishDelta(claims.get(leaf.id)!, 'Interrupted child 🌿');
  const command = { idempotencyKey: 'stop-root', expectedRunId: f.groupTask.runs[0]!.id };
  const result = await f.tasks.cancel(
    f.admin.id,
    f.owner.workspace.id,
    f.grant.conversationId,
    f.groupTask.id,
    command,
  );
  expect(result.receipt).toMatchObject({ affectedTaskCount: 2, affectedRunCount: 2 });
  expect(
    await f.tasks.cancel(
      f.admin.id,
      f.owner.workspace.id,
      f.grant.conversationId,
      f.groupTask.id,
      command,
    ),
  ).toEqual(result);
  expect(
    (
      await f.pool.query('SELECT * FROM task_runs WHERE task_id=$1 OR task_id=$2 ORDER BY id', [
        middle.id,
        failed.id,
      ])
    ).rows,
  ).toEqual(terminalBefore);
  expect(await queue.isClaimActive(claims.get(leaf.id)!)).toBe(false);
  expect(await queue.isClaimActive(claims.get(unrelated.id)!)).toBe(true);
  expect(await queue.finish(claims.get(leaf.id)!, { body: 'Late child', usage: null })).toBe(false);
  expect(
    await f.tasks.partialOutput(
      f.member.id,
      f.owner.workspace.id,
      f.grant.conversationId,
      leaf.id,
      leaf.runId,
    ),
  ).toMatchObject({ partial: { text: 'Interrupted child 🌿', interrupted: true } });
  expect(
    (
      await f.tasks.retry(
        f.member.id,
        f.owner.workspace.id,
        f.grant.conversationId,
        failed.id,
        retryKey,
      )
    ).receipt,
  ).toEqual(retried.receipt);
  await expect(
    f.tasks.retry(f.member.id, f.owner.workspace.id, f.grant.conversationId, failed.id, {
      idempotencyKey: 'new-after-stop',
      expectedRunId: retryClaim.runId,
    }),
  ).rejects.toMatchObject({ code: 'task_retry_cancelled_ancestor' });
  // Multiple authorized Tasks, Runs and a retry exercise the whole retained tree.
}, 15000);

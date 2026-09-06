import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';

describe('COL-17 token budget soft warnings', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('warns when a lifetime pool crosses four fifths and still starts the Run', async () => {
    const f = await taskFixture(cleanup, undefined, { submitInitialTask: false });
    await f.pool.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
      f.owner.workspace.id,
      JSON.stringify({ maxTotalTokens: 40000 }),
    ]);
    const task = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'token-soft',
      body: 'Stay inside the token pool.',
    });
    expect(
      await f
        .worker(async () => ({
          events: [
            { type: 'text', text: 'Reserved under the workspace pool.' },
            { type: 'usage', inputTokens: 20, outputTokens: 4 },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }))
        .runOnce(),
    ).toBe(true);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id),
    ).toMatchObject({
      status: 'completed',
      tokenBudgets: [
        {
          kind: 'workspace',
          used: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
          reserved: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        {
          kind: 'run',
          used: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
        },
      ],
    });
    expect(
      (
        await f.pool.query(
          `SELECT event_type,body,event_data FROM conversation_events
           WHERE event_type='task.limit.warning' AND event_data->>'taskId'=$1
           ORDER BY sequence`,
          [task.id],
        )
      ).rows,
    ).toMatchObject([
      {
        event_type: 'task.limit.warning',
        body: 'Token usage reached 80% of the 40000 total workspace limit.',
        event_data: {
          taskId: task.id,
          dimension: 'totalTokens',
          used: 32768,
          limit: 40000,
          source: 'workspace',
          soft: true,
          hard: false,
        },
      },
    ]);
  });
});

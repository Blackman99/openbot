import { afterEach, describe, expect, it } from 'vitest';
import { modelFailure } from '../../src/providers/failure-taxonomy.js';
import { FALLBACK_DELAY_MS } from '../../src/tasks/retry-schedule.js';
import { costMicros } from '../../src/tasks/model-price.js';
import { ModelPriceService } from '../../src/tasks/model-price-service.js';
import { taskFixture } from '../helpers/task-fixture.js';

const usage = { inputTokens: 20, outputTokens: 4 };

describe('COL-18 cost budget enforcement', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('leaves unpriced models outside cost limits and charges the pinned start-of-run version', async () => {
    const f = await taskFixture(cleanup, undefined, { submitInitialTask: false });
    await f.pool.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
      f.owner.workspace.id,
      JSON.stringify({ maxCostMicros: 1 }),
    ]);
    const unpriced = await f.tasks.submit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      {
        idempotencyKey: 'unpriced-cost',
        body: 'Complete without a price.',
      },
    );
    expect(
      await f
        .worker(async () => ({
          events: [
            { type: 'text', text: 'Unpriced answer.' },
            { type: 'usage', ...usage },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }))
        .runOnce(),
    ).toBe(true);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, unpriced.id),
    ).toMatchObject({
      status: 'completed',
      runs: [{ price: { kind: 'unpriced' } }],
    });
    expect(
      (await f.pool.query('SELECT count(*)::int AS n FROM task_cost_reservations')).rows[0].n,
    ).toBe(0);

    const prices = new ModelPriceService(f.pool);
    const first = await prices.supersede(f.owner.user.id, f.owner.workspace.id, {
      connectionId: f.model.id,
      modelId: f.model.modelId,
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 2_000_000,
    });
    await f.pool.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
      f.owner.workspace.id,
      JSON.stringify({ maxCostMicros: 1_000_000 }),
    ]);
    const priced = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'priced-cost',
      body: 'Charge the start-of-run version.',
    });
    expect(
      await f
        .worker(async () => ({
          events: [
            { type: 'text', text: 'Priced answer.' },
            { type: 'usage', ...usage },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }))
        .runOnce(),
    ).toBe(true);
    await prices.supersede(f.owner.user.id, f.owner.workspace.id, {
      connectionId: f.model.id,
      modelId: f.model.modelId,
      inputMicrosPerMillion: 9_000_000,
      outputMicrosPerMillion: 9_000_000,
    });
    const charged = costMicros(first, usage);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, priced.id),
    ).toMatchObject({
      status: 'completed',
      costBudgets: [
        {
          kind: 'workspace',
          usedMicros: charged,
          reservedMicros: 0,
        },
      ],
      runs: [
        {
          price: {
            kind: 'priced',
            versionId: first.id,
            inputMicrosPerMillion: 1_000_000,
            outputMicrosPerMillion: 2_000_000,
            costMicros: charged,
          },
        },
      ],
    });
  });

  it('charges the fallback model that was actually called and holds waiting_budget on a hard cap', async () => {
    let now = new Date('2026-09-06T12:00:00.000Z');
    const f = await taskFixture(cleanup, () => now, {
      submitInitialTask: false,
      fallbackModel: true,
      retryPolicy: { maxAttemptsPerModel: 1, maxRunsPerChain: 4 },
    });
    const prices = new ModelPriceService(f.pool);
    await prices.supersede(f.owner.user.id, f.owner.workspace.id, {
      connectionId: f.model.id,
      modelId: f.model.modelId,
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 1_000_000,
    });
    const fallbackPrice = await prices.supersede(f.owner.user.id, f.owner.workspace.id, {
      connectionId: f.fallback!.id,
      modelId: f.fallback!.modelId,
      inputMicrosPerMillion: 5_000_000,
      outputMicrosPerMillion: 7_000_000,
    });
    await f.pool.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
      f.owner.workspace.id,
      JSON.stringify({ maxCostMicros: 1_000_000 }),
    ]);
    const task = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'fallback-cost',
      body: 'Switch models.',
    });
    const worker = f.worker(async ({ modelId }) => {
      if (modelId === f.model.modelId)
        return { events: [], raw: '', error: modelFailure('provider_unavailable') };
      return {
        events: [
          { type: 'text', text: 'Fallback answer.' },
          { type: 'usage', ...usage },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      };
    });
    expect(await worker.runOnce()).toBe(true);
    const due = (
      await f.pool.query<{ metadata: { notBefore?: string } }>(
        "SELECT metadata FROM audit_events WHERE event_type='task.queued' AND metadata->>'taskId'=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1",
        [task.id],
      )
    ).rows[0]?.metadata.notBefore;
    now = new Date(due ? Date.parse(due) : now.getTime() + FALLBACK_DELAY_MS + 5_000);
    expect(await worker.runOnce()).toBe(true);
    const charged = costMicros(fallbackPrice, usage);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, task.id),
    ).toMatchObject({
      status: 'completed',
      runs: [
        {
          provider: { modelId: f.fallback!.modelId },
          price: { kind: 'priced', versionId: fallbackPrice.id, costMicros: charged },
        },
      ],
    });

    await f.pool.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
      f.owner.workspace.id,
      JSON.stringify({ maxCostMicros: 1 }),
    ]);
    const held = await f.tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
      idempotencyKey: 'hard-cost',
      body: 'Hold the next Run.',
    });
    expect(await worker.runOnce()).toBe(true);
    expect(
      await f.tasks.get(f.owner.user.id, f.owner.workspace.id, f.conversation.id, held.id),
    ).toMatchObject({ status: 'waiting_budget' });
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM task_runs WHERE task_id=$1 AND status='queued'",
          [held.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});

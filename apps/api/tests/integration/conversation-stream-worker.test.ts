import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { barrier } from '../helpers/barrier.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('worker ordered conversation delivery', () => {
  it('durably delivers the first callback before terminal completion and publishes it only once', async () => {
    const f = await taskFixture(cleanup);
    const callback = barrier(),
      finish = barrier();
    const worker = f.worker(async (_input, _signal, onEvent) => {
      await onEvent?.({ type: 'text', text: 'First 🙂' });
      callback.resolve();
      await finish.promise;
      await onEvent?.({ type: 'text', text: ' then final.' });
      await onEvent?.({ type: 'complete', stopReason: 'stop' });
      return {
        raw: 'private diagnostic',
        events: [
          { type: 'text', text: 'First 🙂' },
          { type: 'text', text: ' then final.' },
          { type: 'complete', stopReason: 'stop' },
        ],
      };
    });
    const running = worker.runOnce();
    await callback.promise;
    const early = (
      await f.pool.query(
        'SELECT * FROM conversation_delivery_events WHERE conversation_id=$1 ORDER BY sequence',
        [f.conversation.id],
      )
    ).rows;
    const earlyTypes = early.map((row) => row.event_type);
    finish.resolve();
    await running;
    expect(earlyTypes).toEqual([
      'message.changed',
      'task.run.updated',
      'task.run.updated',
      'assistant.delta',
    ]);
    expect(early.at(-1)).toMatchObject({ delta_text: 'First 🙂', start_byte: 0, end_byte: 10 });
    const events = (
      await f.pool.query(
        'SELECT * FROM conversation_delivery_events WHERE conversation_id=$1 ORDER BY sequence',
        [f.conversation.id],
      )
    ).rows;
    expect(events.map((row) => Number(row.sequence))).toEqual(
      events.map((_row, index) => index + 1),
    );
    expect(
      events
        .filter((row) => row.event_type === 'assistant.delta')
        .map((row) => row.delta_text)
        .join(''),
    ).toBe('First 🙂 then final.');
    expect(
      events
        .filter((row) => row.event_type === 'task.run.updated')
        .map((row) => row.execution.runStatus),
    ).toEqual(['queued', 'running', 'completed']);
    expect(events.at(-2)?.event_type).toBe('message.changed');
    const read = await f.read();
    expect(read.status).toBe('completed');
    expect(
      (
        await f.pool.query(
          "SELECT id FROM conversation_events WHERE conversation_id=$1 AND event_type='bot.message.created'",
          [f.conversation.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(
      /never-return-provider-secret|claim_token|Instructions visible/u,
    );
  });
});

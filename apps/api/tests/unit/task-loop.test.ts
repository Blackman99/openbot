import { expect, it } from 'vitest';
import { runTaskLoop } from '../../src/tasks/loop.js';

it('continues after a failed poll, executes serially, and stops without another claim', async () => {
  const controller = new AbortController();
  let calls = 0,
    active = 0,
    reports = 0;
  await runTaskLoop(
    {
      runOnce: async (signal) => {
        calls++;
        expect(signal).toBe(controller.signal);
        expect(active++).toBe(0);
        await Promise.resolve();
        active--;
        if (calls === 1) throw new Error('Transient database error with private details');
        if (calls === 3) controller.abort();
        return calls > 1;
      },
    },
    controller.signal,
    () => {
      reports++;
    },
    1,
  );
  expect(calls).toBe(3);
  expect(reports).toBe(1);
});

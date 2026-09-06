import { afterEach, expect, it, vi } from 'vitest';
import { startAvatarCleanup } from '../../src/bots/avatar-cleanup.js';
afterEach(() => vi.useRealTimers());
it('runs bounded maintenance without overlap, retries errors next tick, and drains on shutdown', async () => {
  vi.useFakeTimers();
  let complete = () => {};
  const work = vi
    .fn()
    .mockRejectedValueOnce(new Error('private error'))
    .mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
  const failed = vi.fn();
  const stop = startAvatarCleanup(work, failed);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(work).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledWith();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(work).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(work).toHaveBeenCalledTimes(2);
  let stopped = false;
  const closing = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  complete();
  await closing;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(work).toHaveBeenCalledTimes(2);
});

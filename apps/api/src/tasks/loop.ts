import { setTimeout } from 'node:timers/promises';

export async function runTaskLoop(
  worker: { runOnce(signal: AbortSignal): Promise<boolean> },
  signal: AbortSignal,
  reportFailure: () => void,
  pollIntervalMs = 1000,
): Promise<void> {
  while (!signal.aborted) {
    let handled = false;
    try {
      handled = await worker.runOnce(signal);
    } catch {
      reportFailure();
    }
    if (!handled && !signal.aborted) {
      try {
        await setTimeout(pollIntervalMs, undefined, { signal });
      } catch {
        if (!signal.aborted) throw new Error('Task worker poll failed');
      }
    }
  }
}

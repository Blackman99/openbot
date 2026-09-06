import { afterEach, expect, it, vi } from 'vitest';
import { ModelConnectionProbe, type ProbeReport } from '../../src/providers/model-probe.js';
import type { ModelAdapter } from '../../src/providers/model-events.js';

afterEach(() => vi.useRealTimers());
it.each(['timeout', 'cancel'] as const)(
  'bounds an unfinished admission check by probe %s without starting provider requests',
  async (mode) => {
    vi.useFakeTimers();
    const generate = vi.fn<ModelAdapter['generate']>(async () => ({ events: [], raw: '' }));
    const admission = vi.fn(() => new Promise<void>(() => {}));
    const controller = new AbortController();
    let report: ProbeReport | undefined;
    const completed = new ModelConnectionProbe({ generate }, { timeoutMs: 20 })
      .run(
        { baseUrl: 'https://models.example/v1', modelId: 'model', apiKey: '', headers: {} },
        controller.signal,
        admission,
      )
      .then((value) => {
        report = value;
      });
    if (mode === 'cancel') controller.abort();
    await vi.advanceTimersByTimeAsync(mode === 'timeout' ? 21 : 0);
    expect(report).toMatchObject({
      text: { ok: false, code: mode === 'timeout' ? 'provider_timeout' : 'provider_cancelled' },
      action: { ok: false, code: mode === 'timeout' ? 'provider_timeout' : 'provider_cancelled' },
    });
    await completed;
    expect(generate).not.toHaveBeenCalled();
    expect(admission).toHaveBeenCalledTimes(1);
  },
);

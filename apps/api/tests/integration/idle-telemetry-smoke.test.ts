import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProductionApp } from '../../src/runtime.js';
import { createTelemetry, readTelemetryConfig } from '../../src/telemetry/config.js';
import { runProductionTaskWorker } from '../../src/tasks/runtime.js';

function installFetchProbe() {
  const destinations: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input, init) => {
    if (typeof input === 'string') destinations.push(input);
    else if (input instanceof URL) destinations.push(input.href);
    else destinations.push(input.url);
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    destinations,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

describe('DEPLOY-01 idle telemetry smoke', () => {
  const apps: Array<ReturnType<typeof buildProductionApp>> = [];
  const restores: Array<() => void> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const restore of restores.splice(0)) restore();
  });

  it('keeps an idle API with default telemetry off free of unnecessary outbound HTTP', async () => {
    const probe = installFetchProbe();
    restores.push(probe.restore);
    const telemetry = createTelemetry(readTelemetryConfig({}));
    expect(telemetry.enabled).toBe(false);

    const app = buildProductionApp({
      database: {
        connectionString: 'postgresql://openbot:openbot@127.0.0.1:1/openbot',
      },
      databaseConnectionTimeoutMs: 100,
      databaseQueryTimeoutMs: 100,
      logger: false,
      setupTokenDigest: '4b5d9e48b8fbcf6584a8919aec8686de5a09e4a6310a8488c83a442e8bb88b7e',
      webOrigin: 'http://localhost:3000',
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    telemetry.record('idle_smoke');

    expect(probe.destinations).toEqual([]);
  });

  it('keeps an unconfigured idle worker free of unnecessary outbound HTTP', async () => {
    const probe = installFetchProbe();
    restores.push(probe.restore);
    const controller = new AbortController();
    const states: string[] = [];
    const running = runProductionTaskWorker(
      {
        OPENBOT_PROVIDER_ENCRYPTION_KEY: '',
      },
      controller.signal,
      (state) => states.push(state),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await running;
    expect(states).toEqual(['task_worker_unconfigured']);
    expect(probe.destinations).toEqual([]);
  });
});

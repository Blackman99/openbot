import { createTelemetry, readTelemetryConfig } from './telemetry/config.js';
import { runProductionTaskWorker } from './tasks/runtime.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const telemetry = createTelemetry(readTelemetryConfig(process.env));
  await runProductionTaskWorker(process.env, controller.signal, (state) => {
    telemetry.record('task_worker_state', { state });
    console.info(state);
  });
} catch {
  // Configuration, credential and PostgreSQL diagnostics can contain secrets.
  console.error('task_worker_startup_failed');
  process.exitCode = 1;
}

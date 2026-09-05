import { runProductionTaskWorker } from './tasks/runtime.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  await runProductionTaskWorker(process.env, controller.signal, (state) => console.info(state));
} catch {
  // Configuration, credential and PostgreSQL diagnostics can contain secrets.
  console.error('task_worker_startup_failed');
  process.exitCode = 1;
}

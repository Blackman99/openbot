import pg from 'pg';
import { setTimeout } from 'node:timers/promises';
import { readDatabaseConfig, type Environment } from '../config.js';
import { readProviderConfig } from '../providers/config.js';
import { ProviderSecretBox } from '../providers/secrets.js';
import { ProviderUrlPolicy } from '../providers/url-policy.js';
import { createModelAdapter } from '../providers/protocols.js';
import { TaskWorker } from './worker.js';
import { runTaskLoop } from './loop.js';
import { PostgresReadinessProbe } from '../database/readiness.js';
import { MIGRATION_VERSIONS } from '../database/migrations.js';

export type TaskWorkerState =
  'task_worker_unconfigured' | 'task_worker_ready' | 'task_worker_poll_failed';
function timeout(environment: Environment, key: string) {
  const value = Number(environment[key] ?? 1000);
  if (!Number.isInteger(value) || value < 1 || value > 300000)
    throw new Error('Invalid worker database timeout');
  return value;
}
export async function runProductionTaskWorker(
  environment: Environment,
  signal: AbortSignal,
  report: (state: TaskWorkerState) => void,
) {
  const providers = readProviderConfig(environment);
  if (!providers) {
    report('task_worker_unconfigured');
    // An AbortSignal listener alone does not keep the Node process alive.
    // Keep one abortable timer active while deliberately leaving the queue alone.
    while (!signal.aborted) {
      try {
        await setTimeout(60000, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
    return;
  }
  const pool = new pg.Pool({
    ...readDatabaseConfig(environment),
    connectionTimeoutMillis: timeout(environment, 'DATABASE_CONNECTION_TIMEOUT_MS'),
    query_timeout: timeout(environment, 'DATABASE_QUERY_TIMEOUT_MS'),
  });
  pool.on('error', () => report('task_worker_poll_failed'));
  try {
    const readiness = await new PostgresReadinessProbe(pool, MIGRATION_VERSIONS).check();
    if (readiness.database !== 'ready' || readiness.migrations !== 'current')
      throw new Error('Task worker database is not ready');
    const policy = new ProviderUrlPolicy(providers.network);
    const worker = new TaskWorker(pool, {
      secrets: new ProviderSecretBox(providers.encryptionKey),
      createAdapter: (protocol, options) => createModelAdapter(protocol, policy, options),
    });
    report('task_worker_ready');
    await runTaskLoop(worker, signal, () => report('task_worker_poll_failed'));
  } finally {
    await pool.end();
  }
}

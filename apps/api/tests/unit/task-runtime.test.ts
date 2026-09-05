import { beforeEach, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  created: vi.fn(),
  end: vi.fn(async () => undefined),
  on: vi.fn(),
  query: vi.fn(),
}));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor() {
        database.created();
      }
      readonly query = database.query;
      readonly end = database.end;
      readonly on = database.on;
    },
  },
}));
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import { runProductionTaskWorker } from '../../src/tasks/runtime.js';

beforeEach(() => {
  vi.clearAllMocks();
});

it('reports unconfigured and waits for shutdown without opening the queue database', async () => {
  const signal = new AbortController();
  const states: string[] = [];
  let stopped = false;
  const running = runProductionTaskWorker(
    { DATABASE_URL: 'intentionally-unusable' },
    signal.signal,
    (state) => states.push(state),
  ).then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(states).toEqual(['task_worker_unconfigured']);
  expect(stopped).toBe(false);
  expect(database.created).not.toHaveBeenCalled();
  signal.abort();
  await running;
  expect(stopped).toBe(true);
});

it('reports ready only after the complete migration ledger and releases the pool on shutdown', async () => {
  database.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
  database.query.mockResolvedValueOnce({
    rows: MIGRATION_VERSIONS.map((version) => ({ version })),
  });
  const signal = new AbortController();
  const states: string[] = [];
  await runProductionTaskWorker(
    {
      OPENBOT_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      DATABASE_URL: 'postgresql://openbot:fixture@postgres/openbot',
    },
    signal.signal,
    (state) => {
      states.push(state);
      signal.abort();
    },
  );
  expect(states).toEqual(['task_worker_ready']);
  expect(database.created).toHaveBeenCalledTimes(1);
  expect(database.query).toHaveBeenCalledTimes(2);
  expect(database.end).toHaveBeenCalledTimes(1);
});

it('fails startup with no ready announcement when the migration ledger is stale', async () => {
  database.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
  database.query.mockResolvedValueOnce({ rows: [{ version: MIGRATION_VERSIONS[0] }] });
  const states: string[] = [];
  await expect(
    runProductionTaskWorker(
      {
        OPENBOT_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        DATABASE_URL: 'postgresql://openbot:fixture@postgres/openbot',
      },
      new AbortController().signal,
      (state) => states.push(state),
    ),
  ).rejects.toThrow('Task worker database is not ready');
  expect(states).toEqual([]);
  expect(database.end).toHaveBeenCalledTimes(1);
});

import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

it('keeps an unconfigured worker process idle until graceful shutdown', async () => {
  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../../src/worker.ts', import.meta.url))],
    {
      env: {
        ...process.env,
        OPENBOT_PROVIDER_ENCRYPTION_KEY: '',
        DATABASE_URL: 'unconfigured-worker-must-not-open-database',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '',
    diagnostics = '',
    closed = false;
  worker.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  worker.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const ended = new Promise<number | null>((resolve) =>
    worker.once('close', (code) => {
      closed = true;
      resolve(code);
    }),
  );
  try {
    await vi.waitFor(() => expect(output).toContain('task_worker_unconfigured'), { timeout: 5000 });
    await setTimeout(100);
    expect(closed, diagnostics).toBe(false);
    worker.kill('SIGTERM');
    expect(await ended).toBe(0);
    expect(diagnostics).toBe('');
  } finally {
    if (!closed) worker.kill('SIGTERM');
    await ended;
  }
});

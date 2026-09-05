import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('API server command', () => {
  it('fails clearly when required startup configuration is missing', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: apiRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'API startup failed: DATABASE_URL or PGHOST, PGUSER, PGPASSWORD, and PGDATABASE is required',
    );
  });
});

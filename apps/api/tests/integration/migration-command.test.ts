import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('pnpm db:migrate', () => {
  it('loads the documented repository .env file when it exists', () => {
    const packageJson = JSON.parse(readFileSync(`${apiRoot}/package.json`, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.migrate).toContain('--env-file-if-exists=../../.env');
  });

  it('fails clearly when database configuration is missing', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/database/migrate.ts'], {
      cwd: apiRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'DATABASE_URL or PGHOST, PGUSER, PGPASSWORD, and PGDATABASE is required',
    );
  });

  it('loads the runtime privilege command and rejects a missing runtime password', () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../../../infra/postgres/grant-runtime-privileges.mjs', import.meta.url),
        ),
      ],
      { encoding: 'utf8', env: { ...process.env, OPENBOT_DATABASE_PASSWORD: '' } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OPENBOT_DATABASE_PASSWORD must be between 16 and 1024 bytes');
  });
});

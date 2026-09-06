import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { newDb } from 'pg-mem';
import { registerAdvisoryXactLockStub } from '../helpers/provider-database.js';
import type { Pool } from 'pg';
import { it, expect } from 'vitest';
import { parse } from 'yaml';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { InvitationService } from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';

it('executes the Compose group HTTP assertions against the actual API response contracts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-group-workflow-'));
  const database = newDb({ noAstCoverageCheck: true });
  registerAdvisoryXactLockStub(database);
  const pool: Pool = new (database.adapters.createPg().Pool)();
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$workflow-test-only',
  });
  const app = buildApp({
    auth,
    groups: new GroupService(new PostgresGroupRepository(pool)),
    invitations: new InvitationService(
      new PostgresInvitationRepository(pool),
      () => new Date(),
      async () => '$argon2id$workflow-test-only',
    ),
    members: new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(pool)),
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  try {
    await migrateDatabase(pool, { installPostgresGuards: false });
    const owner = await auth.setup({
      displayName: 'Compose owner',
      email: 'workflow-owner@example.com',
      password: 'workflow-test-password',
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await writeFile(
      join(directory, 'openbot-workspace.json'),
      JSON.stringify({ workspace: owner.workspace }),
    );
    await writeFile(
      join(directory, 'openbot-workspace-cookies.txt'),
      `# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\topenbot_session\t${owner.sessionToken}\n`,
    );
    const workflow = parse(
      await readFile(new URL('../../../../.github/workflows/verify.yml', import.meta.url), 'utf8'),
    ) as { jobs: { compose: { steps: Array<{ name?: string; run?: string }> } } };
    const step = workflow.jobs.compose.steps.find(
      ({ name }) => name === 'Verify groups and human membership with the restricted runtime role',
    );
    if (!step?.run) throw new Error('Missing Compose group smoke step');
    // Execute the actual workflow's HTTP commands and jq assertions, without Docker SQL.
    // Native SQL/role checks remain the separate mandatory Compose gate. Below, verify
    // the persisted lifecycle using ordinary pg-mem queries rather than faking psql output.
    const nativeSqlAssertion =
      /^\s*(?:(?:retained_grant|retained_author|group_audits|unsafe_group_audits|audit_count)=|test "\$(?:retained_grant|retained_author|group_audits|unsafe_group_audits|audit_count)|test "\$\(group_sql)/u;
    const script = step.run
      .split('\n')
      .filter((line) => !nativeSqlAssertion.test(line))
      .join('\n')
      .replaceAll('http://localhost:3001', address)
      .replaceAll('/tmp/', `${directory}/`);
    const path = join(directory, 'group-smoke.sh');
    await writeFile(path, script);
    const result = await promisify(execFile)('bash', ['-e', '-o', 'pipefail', path], {
      timeout: 20_000,
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: Error & { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      }),
    );
    expect(result, 'The workflow HTTP assertions must accept production response shapes').toEqual({
      code: 0,
      stdout: expect.any(String),
      stderr: '',
    });
    const author = (
      await pool.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [
        'group-b@example.com',
      ])
    ).rows[0];
    expect(author).toBeDefined();
    const group = (
      await pool.query<{ id: string; created_by_user_id: string; visibility: string }>(
        'SELECT id,created_by_user_id,visibility FROM groups WHERE name=$1',
        ['Compose group'],
      )
    ).rows[0];
    expect(group).toMatchObject({ created_by_user_id: author?.id, visibility: 'private' });
    expect(
      (
        await pool.query('SELECT role FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
          group?.id,
          author?.id,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query(
          'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
          [owner.workspace.id, author?.id],
        )
      ).rows,
    ).toEqual([{ role: 'member' }]);
    const audits = (
      await pool.query<{ event_type: string }>(
        "SELECT event_type FROM audit_events WHERE metadata->>'groupId'=$1 ORDER BY event_type",
        [group?.id],
      )
    ).rows.map(({ event_type }) => event_type);
    expect(audits).toEqual([
      'group.created',
      'group.member_added',
      'group.member_added',
      'group.member_added',
      'group.member_removed',
      'group.member_removed',
      'group.member_role_changed',
      'group.metadata_changed',
      'group.metadata_changed',
    ]);
  } finally {
    await app.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

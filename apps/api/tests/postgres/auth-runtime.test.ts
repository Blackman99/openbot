import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import {
  InstanceAlreadyClaimedError,
  type ClaimInstanceRecord,
} from '../../src/auth/repository.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import {
  WorkspaceAccessError,
  WorkspaceService,
  type WorkspaceWrite,
} from '../../src/workspaces/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

function invalidClaim(): ClaimInstanceRecord {
  const now = new Date('2030-01-02T03:04:05.000Z');
  return {
    claimedAt: now,
    credentialUpdatedAt: now,
    email: 'rollback@example.com',
    instanceClaimAuditId: randomUUID(),
    passwordHash: 'not-an-argon2id-hash',
    sessionCreatedAt: now,
    sessionExpiresAt: new Date('2030-02-01T03:04:05.000Z'),
    sessionSignInAuditId: randomUUID(),
    sessionTokenDigest: '1'.repeat(64),
    userDisplayName: 'Rollback Owner',
    userId: randomUUID(),
    workspaceId: randomUUID(),
    workspaceName: 'Rollback Workspace',
  };
}

postgresDescribe('real PostgreSQL local-owner invariants', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    await migrateDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rolls back a failed claim, serializes concurrent claims, and makes audits append-only', async () => {
    const repository = new PostgresAuthRepository(pool);

    await expect(repository.claimInstance(invalidClaim())).rejects.toThrow();
    for (const table of [
      'instance_claims',
      'users',
      'local_credentials',
      'workspaces',
      'workspace_memberships',
      'sessions',
      'audit_events',
    ]) {
      await expect(
        pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`),
      ).resolves.toMatchObject({
        rows: [{ count: 0 }],
      });
    }

    let hashCalls = 0;
    let releaseHashes: () => void = () => undefined;
    const bothRequestsReady = new Promise<void>((resolve) => {
      releaseHashes = resolve;
    });
    const service = new LocalAuthService(repository, {
      generateId: randomUUID,
      generateSessionToken: () => randomBytes(32).toString('base64url'),
      hashPassword: async () => {
        hashCalls += 1;
        if (hashCalls === 2) {
          releaseHashes();
        }
        await bothRequestsReady;
        return '$argon2id$ci-fixture';
      },
    });

    const claims = await Promise.allSettled([
      service.setup({
        displayName: 'First Owner',
        email: 'first@example.com',
        password: 'correct horse battery staple',
      }),
      service.setup({
        displayName: 'Second Owner',
        email: 'second@example.com',
        password: 'another secure password',
      }),
    ]);
    expect(claims.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = claims.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(InstanceAlreadyClaimedError);
    }

    await expect(
      service.setup({
        displayName: 'Third Owner',
        email: 'third@example.com',
        password: 'third secure password',
      }),
    ).rejects.toBeInstanceOf(InstanceAlreadyClaimedError);

    for (const [table, expected] of [
      ['instance_claims', 1],
      ['users', 1],
      ['local_credentials', 1],
      ['workspaces', 1],
      ['workspace_memberships', 1],
      ['sessions', 1],
      ['audit_events', 2],
    ] as const) {
      await expect(
        pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`),
      ).resolves.toMatchObject({
        rows: [{ count: expected }],
      });
    }

    const audit = await pool.query(
      'SELECT event_type, metadata FROM audit_events ORDER BY event_type',
    );
    expect(JSON.stringify(audit.rows)).not.toMatch(
      /correct horse|another secure|password|cookie|model.?secret|session.?token/iu,
    );
    await expect(pool.query("UPDATE audit_events SET metadata = '{}'::jsonb")).rejects.toThrow(
      /append-only/u,
    );
    await expect(pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/u);
    await expect(pool.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/u);
    await expect(
      pool.query('SELECT COUNT(*)::int AS count FROM audit_events'),
    ).resolves.toMatchObject({
      rows: [{ count: 2 }],
    });
  });

  it('atomically creates isolated workspaces and rolls back setting changes when their audit insert fails', async () => {
    const repository = new PostgresWorkspaceRepository(pool);
    const service = new WorkspaceService(repository);
    const userIds = [randomUUID(), randomUUID()];
    for (const userId of userIds) {
      await pool.query(
        'INSERT INTO users (id, email, normalized_email, display_name, created_at) VALUES ($1, $2, $2, $3, NOW())',
        [userId, `${userId}@example.com`, 'Workspace owner'],
      );
    }
    const firstUser = userIds[0]!;
    const secondUser = userIds[1]!;
    const first = await service.create(firstUser, {
      name: 'Project',
      description: 'First private content',
    });
    const second = await service.create(secondUser, {
      name: 'Project',
      description: 'Second private content',
    });
    await expect(service.list(firstUser)).resolves.toEqual([first]);
    await expect(service.list(secondUser)).resolves.toEqual([second]);
    await expect(service.get(firstUser, second.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(service.update(firstUser, second.id, { name: 'Hacked' })).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
    const existingAudit = await pool.query<{ id: string }>(
      "SELECT id FROM audit_events WHERE event_type = 'workspace.created' LIMIT 1",
    );
    const failedUpdate: WorkspaceWrite = {
      actorUserId: firstUser,
      auditId: existingAudit.rows[0]!.id,
      occurredAt: new Date(),
      workspaceId: first.id,
      name: 'Must roll back',
      description: 'Must roll back',
    };
    await expect(repository.update(failedUpdate)).rejects.toThrow();
    await expect(service.get(firstUser, first.id)).resolves.toEqual(first);
    const failedCreate = { ...failedUpdate, workspaceId: randomUUID() };
    await expect(repository.create(failedCreate)).rejects.toThrow();
    expect(
      (await pool.query('SELECT id FROM workspaces WHERE id = $1', [failedCreate.workspaceId]))
        .rows,
    ).toEqual([]);
    expect(
      (
        await pool.query('SELECT user_id FROM workspace_memberships WHERE workspace_id = $1', [
          failedCreate.workspaceId,
        ])
      ).rows,
    ).toEqual([]);
    await expect(
      service.update(firstUser, first.id, { name: 'Updated', description: 'New private content' }),
    ).resolves.toMatchObject({ name: 'Updated' });
    const audits = await pool.query(
      "SELECT metadata FROM audit_events WHERE event_type = 'workspace.settings_changed' AND actor_user_id = $1",
      [firstUser],
    );
    expect(audits.rows).toEqual([
      { metadata: { workspaceId: first.id, changedFields: ['name', 'description'] } },
    ]);
    await expect(service.get(secondUser, second.id)).resolves.toEqual(second);
  });
});

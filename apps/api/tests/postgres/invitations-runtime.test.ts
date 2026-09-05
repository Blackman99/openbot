import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService, type AuthenticatedSession } from '../../src/auth/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { InvitationService, invitationDigest } from '../../src/invitations/service.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('real PostgreSQL invitation transactions', () => {
  // A separate schema keeps this suite independent of the first-owner invariant suite.
  const schema = `invites_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const repository = new PostgresInvitationRepository(pool);
  const invitations = new InvitationService(
    repository,
    () => new Date(),
    async () => '$argon2id$ci-fixture',
  );
  let owner: AuthenticatedSession;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateDatabase(pool);
    owner = await new LocalAuthService(new PostgresAuthRepository(pool), {
      hashPassword: async () => '$argon2id$ci-fixture',
    }).setup({
      email: 'owner@example.com',
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('consumes exactly once under concurrent signup and rolls back a failed account transaction', async () => {
    const created = await invitations.create(owner.user.id, owner.workspace.id, {
      email: 'concurrent@example.com',
      role: 'member',
      expiresInDays: 7,
    });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        invitations.accept({
          token: created.token,
          email: 'concurrent@example.com',
          displayName: 'Concurrent',
          password: 'correct horse battery staple',
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM users WHERE normalized_email = 'concurrent@example.com'",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM audit_events WHERE event_type = 'invitation.accepted' AND metadata->>'invitationId' = $1",
          [created.invitation.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    const invalid = await invitations.create(owner.user.id, owner.workspace.id, {
      email: 'rollback@example.com',
      role: 'member',
      expiresInDays: 1,
    });
    const userId = randomUUID();
    const now = new Date();
    await expect(
      repository.accept({
        tokenDigest: invitationDigest(invalid.token),
        email: 'rollback@example.com',
        userId,
        newAccount: { displayName: 'Rollback', passwordHash: 'invalid-hash' },
        now,
        auditId: randomUUID(),
        session: {
          tokenDigest: 'a'.repeat(64),
          expiresAt: new Date(now.getTime() + 86_400_000),
          auditId: randomUUID(),
        },
      }),
    ).rejects.toThrow();
    expect((await pool.query('SELECT id FROM users WHERE id = $1', [userId])).rows).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT consumed_at FROM workspace_invitations WHERE id = $1', [
          invalid.invitation.id,
        ])
      ).rows,
    ).toEqual([{ consumed_at: null }]);
    expect(
      (
        await invitations.accept({
          token: invalid.token,
          email: 'rollback@example.com',
          displayName: 'Recovered',
          password: 'correct horse battery staple',
        })
      ).identity.user.displayName,
    ).toBe('Recovered');
  });

  it('serializes revocation against acceptance and keeps identical-email signup atomic across workspaces', async () => {
    const raced = await invitations.create(owner.user.id, owner.workspace.id, {
      email: 'revoke-race@example.com',
      role: 'member',
      expiresInDays: 1,
    });
    const outcomes = await Promise.allSettled([
      invitations.revoke(owner.user.id, owner.workspace.id, raced.invitation.id),
      invitations.accept({
        token: raced.token,
        email: 'revoke-race@example.com',
        displayName: 'Race',
        password: 'correct horse battery staple',
      }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const state = (
      await pool.query('SELECT revoked_at,consumed_at FROM workspace_invitations WHERE id = $1', [
        raced.invitation.id,
      ])
    ).rows[0];
    expect(Boolean(state.revoked_at) !== Boolean(state.consumed_at)).toBe(true);

    const other = await new WorkspaceService(new PostgresWorkspaceRepository(pool)).create(
      owner.user.id,
      { name: 'Other' },
    );
    const invitationsForSameEmail = await Promise.all(
      [owner.workspace.id, other.id].map((workspaceId) =>
        invitations.create(owner.user.id, workspaceId, {
          email: 'one-account@example.com',
          role: 'member',
          expiresInDays: 1,
        }),
      ),
    );
    const accepted = await Promise.allSettled(
      invitationsForSameEmail.map((invite) =>
        invitations.accept({
          token: invite.token,
          email: 'one-account@example.com',
          displayName: 'One Account',
          password: 'correct horse battery staple',
        }),
      ),
    );
    expect(accepted.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM users WHERE normalized_email = 'one-account@example.com'",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM workspace_invitations WHERE email = 'one-account@example.com' AND consumed_at IS NULL",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
});

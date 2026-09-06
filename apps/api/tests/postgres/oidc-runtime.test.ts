import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalAuthService, type AuthenticatedOwnerSession } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { InvitationService } from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { OidcService, oidcDigest } from '../../src/oidc/service.js';
import { PostgresOidcRepository } from '../../src/oidc/postgres-repository.js';
import { OpenIdProvider } from '../../src/oidc/provider.js';
import { startMockIdp } from '../helpers/mock-idp.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('real PostgreSQL OIDC transactions', () => {
  const schema = `oidc_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$ci-fixture',
  });
  const repository = new PostgresOidcRepository(pool);
  const invitations = new InvitationService(new PostgresInvitationRepository(pool));
  let owner: AuthenticatedOwnerSession;
  let idp: Awaited<ReturnType<typeof startMockIdp>>;
  let oidc: OidcService;
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateDatabase(pool);
    owner = await auth.setup({
      displayName: 'Owner',
      email: 'owner@example.com',
      password: 'correct horse battery staple',
    });
    idp = await startMockIdp();
    const callbackUrl = 'http://127.0.0.1:4173/auth/oidc/callback';
    oidc = new OidcService(
      auth,
      repository,
      new OpenIdProvider({
        issuer: idp.issuer,
        clientId: 'openbot',
        clientSecret: 'test-secret',
        callbackUrl,
        allowLoopbackHttp: true,
      }),
      idp.issuer,
      callbackUrl,
    );
  });
  afterAll(async () => {
    await idp?.close();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  it('atomically consumes one browser transaction and issues only one session under callback concurrency', async () => {
    const link = await oidc.start('link', owner.sessionToken);
    await oidc.finish(idp.issue(link.authorizationUrl), link.browserToken, owner.sessionToken);
    const flow = await oidc.start('signin');
    const callback = idp.issue(flow.authorizationUrl);
    const outcomes = await Promise.allSettled([
      oidc.finish(callback, flow.browserToken),
      oidc.finish(callback, flow.browserToken),
    ]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect((await pool.query('SELECT token_digest FROM sessions')).rows).toHaveLength(2);
  });
  it('consumes a shared invitation once across different OIDC browser transactions', async () => {
    const invite = await invitations.create(owner.user.id, owner.workspace.id, {
      email: 'grace@example.com',
      role: 'member',
      expiresInDays: 1,
    });
    const flows = await Promise.all([
      oidc.start('invite', undefined, invite.token),
      oidc.start('invite', undefined, invite.token),
    ]);
    const outcomes = await Promise.allSettled(
      flows.map((flow, index) =>
        oidc.finish(
          idp.issue(flow.authorizationUrl, {
            sub: `grace-${index}`,
            email: 'grace@example.com',
            name: 'Grace',
          }),
          flow.browserToken,
        ),
      ),
    );
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await pool.query("SELECT id FROM users WHERE normalized_email='grace@example.com'")).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT id FROM audit_events WHERE event_type='invitation.accepted' AND metadata->>'invitationId'=$1",
          [invite.invitation.id],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('rolls back invitation, user, identity, membership and session together when audit insertion fails', async () => {
    const invite = await invitations.create(owner.user.id, owner.workspace.id, {
      email: 'rollback@example.com',
      role: 'member',
      expiresInDays: 1,
    });
    const userId = randomUUID();
    const now = new Date();
    const existingAudit = (await pool.query('SELECT id FROM audit_events LIMIT 1')).rows[0].id;
    await expect(
      repository.complete({
        transaction: {
          stateDigest: 'a'.repeat(64),
          browserDigest: 'b'.repeat(64),
          purpose: 'invite',
          nonce: 'nonce',
          verifier: 'verifier',
          sessionDigest: null,
          invitationDigest: oidcDigest(invite.token),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 600_000),
        },
        claims: {
          issuer: idp.issuer,
          subject: 'rollback-subject',
          email: 'rollback@example.com',
          emailVerified: true,
        },
        now,
        sessionDigest: 'c'.repeat(64),
        expiresAt: new Date(now.getTime() + 86_400_000),
        userId,
        auditId: existingAudit,
        identityAuditId: randomUUID(),
        invitationAuditId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect((await pool.query('SELECT id FROM users WHERE id=$1', [userId])).rows).toHaveLength(0);
    expect(
      (await pool.query('SELECT user_id FROM oidc_identities WHERE user_id=$1', [userId])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query('SELECT user_id FROM sessions WHERE user_id=$1', [userId])).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT consumed_at FROM workspace_invitations WHERE id=$1', [
          invite.invitation.id,
        ])
      ).rows,
    ).toEqual([{ consumed_at: null }]);
  });
  it('revalidates the originating session after a concurrent revocation waits on the same row', async () => {
    await oidc.unlink(owner.sessionToken);
    const link = await oidc.start('link', owner.sessionToken);
    const connection = await pool.connect();
    await connection.query('BEGIN');
    await connection.query('SELECT token_digest FROM sessions WHERE token_digest=$1 FOR UPDATE', [
      oidcDigest(owner.sessionToken),
    ]);
    const count = idp.redemptionCount;
    const callback = oidc.finish(
      idp.issue(link.authorizationUrl),
      link.browserToken,
      owner.sessionToken,
    );
    const outcome = callback.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    try {
      for (let attempt = 0; attempt < 200 && idp.redemptionCount === count; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(idp.redemptionCount).toBeGreaterThan(count);
      await connection.query('UPDATE sessions SET revoked_at=$2 WHERE token_digest=$1', [
        oidcDigest(owner.sessionToken),
        new Date(),
      ]);
      await connection.query('COMMIT');
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
    expect(await outcome).toMatchObject({ ok: false, error: { code: 'authentication_required' } });
    expect(
      (await pool.query('SELECT user_id FROM oidc_identities WHERE user_id=$1', [owner.user.id]))
        .rows,
    ).toHaveLength(0);
  });
});

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import { LocalAuthService, type AuthenticatedOwnerSession } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { OidcService } from '../../src/oidc/service.js';
import { PostgresOidcRepository } from '../../src/oidc/postgres-repository.js';
import { OpenIdProvider } from '../../src/oidc/provider.js';
import { InvitationService } from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { startMockIdp } from '../helpers/mock-idp.js';
const databaseUrl = process.env.TEST_OIDC_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('OIDC with the deployed restricted database role', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let runtime: pg.Pool;
  let idp: Awaited<ReturnType<typeof startMockIdp>>;
  let auth: LocalAuthService;
  let oidc: OidcService;
  let owner: AuthenticatedOwnerSession;
  beforeAll(async () => {
    await migrateDatabase(admin);
    const url = new URL(databaseUrl!);
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../../../infra/postgres/grant-runtime-privileges.mjs', import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          PGHOST: url.hostname,
          PGPORT: url.port || '5432',
          PGDATABASE: url.pathname.slice(1),
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          OPENBOT_DATABASE_PASSWORD: 'ci-oidc-runtime-password',
        },
      },
    );
    url.username = 'openbot_runtime';
    url.password = 'ci-oidc-runtime-password';
    runtime = new pg.Pool({ connectionString: url.toString() });
    auth = new LocalAuthService(new PostgresAuthRepository(runtime), {
      hashPassword: async () => '$argon2id$ci-fixture',
    });
    owner = await auth.setup({
      displayName: 'Owner',
      email: 'owner@example.com',
      password: 'correct horse battery staple',
    });
    idp = await startMockIdp();
    const callbackUrl = 'http://127.0.0.1:4173/auth/oidc/callback';
    oidc = new OidcService(
      auth,
      new PostgresOidcRepository(runtime),
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
    await runtime?.end();
    await admin.end();
  });
  it('links, signs in, registers an invitee and enforces unlink/rollback using only deployed privileges', async () => {
    const link = await oidc.start('link', owner.sessionToken);
    await oidc.finish(idp.issue(link.authorizationUrl), link.browserToken, owner.sessionToken);
    const signin = await oidc.start('signin');
    const signed = await oidc.finish(idp.issue(signin.authorizationUrl), signin.browserToken);
    expect((await auth.getSession(signed.sessionToken!))?.user.id).toBe(owner.user.id);
    const invitations = new InvitationService(new PostgresInvitationRepository(runtime));
    const invite = await invitations.create(owner.user.id, owner.workspace.id, {
      email: 'grace@example.com',
      role: 'member',
      expiresInDays: 1,
    });
    const flow = await oidc.start('invite', undefined, invite.token);
    const joined = await oidc.finish(
      idp.issue(flow.authorizationUrl, { sub: 'grace', email: 'grace@example.com', name: 'Grace' }),
      flow.browserToken,
    );
    expect((await auth.getSession(joined.sessionToken!))?.user.email).toBe('grace@example.com');
    await expect(oidc.unlink(joined.sessionToken!)).rejects.toMatchObject({
      code: 'last_credential',
    });
    await expect(
      runtime.query('UPDATE users SET is_instance_admin=TRUE WHERE id=$1', [owner.user.id]),
    ).rejects.toThrow();
    await expect(
      runtime.query("UPDATE oidc_identities SET subject='attacker' WHERE user_id=$1", [
        owner.user.id,
      ]),
    ).rejects.toThrow();
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(oidc.unlink(owner.sessionToken)).rejects.toThrow();
      expect(await oidc.settings(owner.sessionToken)).toEqual({ linked: true, canUnlink: true });
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    await oidc.unlink(owner.sessionToken);
    expect(await oidc.settings(owner.sessionToken)).toEqual({ linked: false, canUnlink: false });
  });
});

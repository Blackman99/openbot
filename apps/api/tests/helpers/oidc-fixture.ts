import { newMemDatabase } from './provider-database.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { PostgresOidcRepository } from '../../src/oidc/postgres-repository.js';
import { OidcService } from '../../src/oidc/service.js';
import { OpenIdProvider } from '../../src/oidc/provider.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { startMockIdp } from './mock-idp.js';
export async function oidcFixture(close: Array<() => Promise<unknown>>) {
  const database = newMemDatabase();
  const pool = new (database.adapters.createPg().Pool)();
  close.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$test-only',
    verifyPassword: async () => true,
  });
  const owner = await auth.setup({
    displayName: 'Ada',
    email: 'ada@example.com',
    password: 'correct horse battery staple',
  });
  const idp = await startMockIdp();
  close.push(idp.close);
  const callbackUrl = 'http://127.0.0.1:4173/auth/oidc/callback';
  const oidc = new OidcService(
    auth,
    new PostgresOidcRepository(pool),
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
  return { pool, auth, owner, idp, oidc };
}

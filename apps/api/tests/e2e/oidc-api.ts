import { newMemDatabase } from '../helpers/provider-database.js';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { InvitationService } from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { OidcService } from '../../src/oidc/service.js';
import { PostgresOidcRepository } from '../../src/oidc/postgres-repository.js';
import { OpenIdProvider } from '../../src/oidc/provider.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { startMockIdp } from '../helpers/mock-idp.js';
const database = newMemDatabase();
// Lock behavior is verified by the real PostgreSQL suites; this fixture exercises browser + API + SQL paths.
const pool = new (database.adapters.createPg().Pool)();
await migrateDatabase(pool, { installPostgresGuards: false });
const auth = new LocalAuthService(new PostgresAuthRepository(pool));
await auth.setup({
  displayName: 'Ada',
  email: 'ada@example.com',
  password: 'correct horse battery staple',
});
const idp = await startMockIdp();
const webOrigin = 'http://127.0.0.1:4173';
const callbackUrl = `${webOrigin}/auth/oidc/callback`;
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
const app = buildApp({
  auth,
  oidc,
  webOrigin,
  invitations: new InvitationService(new PostgresInvitationRepository(pool)),
  workspaces: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
  readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
});
app.post('/__oidc/claims', async (request, reply) => {
  idp.setClaims(request.body as Record<string, unknown>);
  return reply.code(204).send();
});
app.get('/__oidc/counts', async () => ({
  users: (await pool.query('SELECT id FROM users')).rows.length,
  identities: (await pool.query('SELECT subject FROM oidc_identities')).rows.length,
  redemptions: idp.redemptionCount,
}));
app.addHook('onClose', async () => {
  await idp.close();
  await pool.end();
});
process.once('SIGTERM', () => void app.close());
process.once('SIGINT', () => void app.close());
await app.listen({ host: '127.0.0.1', port: 4399 });

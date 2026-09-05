import { buildApp } from '../../src/app.js';
import { ApiTokenService, type ApiTokenScope } from '../../src/api-tokens/service.js';
import { PostgresApiTokenRepository } from '../../src/api-tokens/postgres-repository.js';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotVersionService } from '../../src/bots/version-service.js';
import { BotLifecycleService } from '../../src/bots/lifecycle-service.js';
import { botAclFixture } from './bot-acl-fixture.js';

export async function publicBotFixture(cleanup: Array<() => Promise<unknown>>) {
  const base = await botAclFixture(cleanup);
  const tokens = new ApiTokenService(new PostgresApiTokenRepository(base.pool));
  const publicApp = buildApp({
    auth: base.auth,
    apiTokens: tokens,
    bots: new BotService(new PostgresBotRepository(base.pool)),
    botVersions: new BotVersionService(base.pool, {
      read: async () => {
        throw new Error('This fixture has no avatar bytes');
      },
    }),
    botLifecycle: new BotLifecycleService(base.pool),
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => publicApp.close());
  async function bearer(scopes: ApiTokenScope[], actor = base.owner.user.id) {
    const created = await tokens.create(actor, base.owner.workspace.id, {
      name: 'Public Bot client',
      scopes,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    return { authorization: `Bearer ${created.secret}` };
  }
  return { ...base, publicApp, tokens, bearer };
}

import { buildApp } from '../../src/app.js';
import { ApiTokenService, type ApiTokenScope } from '../../src/api-tokens/service.js';
import { PostgresApiTokenRepository } from '../../src/api-tokens/postgres-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupRoutingService } from '../../src/routing/service.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { TaskService } from '../../src/tasks/service.js';
import { WorkspaceEventService } from '../../src/events/service.js';
import { botAclFixture } from './bot-acl-fixture.js';

export async function publicTaskFixture(
  cleanup: Array<() => Promise<unknown>>,
  options: { actionSupported?: boolean } = {},
) {
  const base = await botAclFixture(cleanup, options);
  const tokens = new ApiTokenService(new PostgresApiTokenRepository(base.pool));
  const groups = new GroupService(new PostgresGroupRepository(base.pool));
  const groupBots = new GroupBotService(new PostgresGroupBotRepository(base.pool));
  const groupRouting = new GroupRoutingService(base.pool);
  const conversations = new ConversationService(new PostgresConversationRepository(base.pool));
  const tasks = new TaskService(base.pool);
  const workspaceEvents = new WorkspaceEventService(base.pool);
  const publicApp = buildApp({
    auth: base.auth,
    apiTokens: tokens,
    groups,
    groupBots,
    groupRouting,
    conversations,
    tasks,
    workspaceEvents,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => publicApp.close());
  const sessionApp = buildApp({
    auth: base.auth,
    groups,
    groupBots,
    groupRouting,
    conversations,
    tasks,
    workspaceEvents,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    webOrigin: 'http://localhost:3000',
  });
  cleanup.push(() => sessionApp.close());
  async function bearer(scopes: ApiTokenScope[], actor = base.owner.user.id) {
    const created = await tokens.create(actor, base.owner.workspace.id, {
      name: 'Public task client',
      scopes,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    return { authorization: `Bearer ${created.secret}` };
  }
  async function readyGroup() {
    const created = await publicApp.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: await bearer(['groups:write']),
      payload: { name: 'Task group' },
    });
    const groupId = created.json().group.id as string;
    const invited = await publicApp.inject({
      method: 'POST',
      url: `/v1/groups/${groupId}/bots`,
      headers: await bearer(['groups:write']),
      payload: { botId: base.bot.id, idempotencyKey: 'task-bot' },
    });
    const leadGrantId = invited.json().grant.id as string;
    return { groupId, leadGrantId };
  }
  return {
    ...base,
    publicApp,
    sessionApp,
    tokens,
    groups,
    groupBots,
    groupRouting,
    conversations,
    tasks,
    workspaceEvents,
    bearer,
    readyGroup,
  };
}

import { botAclFixture } from './bot-acl-fixture.js';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { MemoryService } from '../../src/memories/service.js';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
export async function memoryFixture(
  cleanup: Array<() => Promise<unknown>>,
  options: { onMemoryQuery?: (statement: string) => void } = {},
) {
  const f = await botAclFixture(cleanup);
  const groups = new GroupService(new PostgresGroupRepository(f.pool));
  const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
    name: 'Group memories',
  });
  const member = await f.addUser();
  await groups.addMember(f.owner.user.id, f.owner.workspace.id, group.id, {
    userId: member.id,
    role: 'member',
  });
  const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
  const conversation = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
    subject: { kind: 'group', id: group.id },
  });
  const source = await conversations.append(
    f.owner.user.id,
    f.owner.workspace.id,
    conversation.id,
    { idempotencyKey: 'source', body: 'The launch code is cobalt.' },
  );
  const memoryPool: SqlPool = {
    connect: async () => {
      const connection = await f.pool.connect();
      return {
        query: (statement, values) => {
          options.onMemoryQuery?.(statement);
          return connection.query(statement, values);
        },
        release: () => connection.release(),
      };
    },
  };
  const memories = new MemoryService(memoryPool);
  const grants = new GroupBotService(new PostgresGroupBotRepository(f.pool));
  const app = buildApp({
    auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
    memories,
    conversations,
    groups,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  return {
    ...f,
    aclApp: f.app,
    app,
    memories,
    grants,
    groups,
    group,
    member,
    conversations,
    conversation,
    source,
    path: `/api/v1/workspaces/${f.owner.workspace.id}/groups/${group.id}/memories`,
    command: {
      messageId: source.messageId,
      expectedSourceEventId: source.eventId,
      confidence: 0.5,
      idempotencyKey: 'save-memory',
    },
  };
}

import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { taskFixture } from './task-fixture.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { BotService } from '../../src/bots/service.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';

// pg-mem generates different names for unnamed CHECKs in immutable0017/0019.
// Replace exactly those five status checks with the new named0023 checks.
// All trigger, privilege, locking, upgrade and rollback evidence remains native.
export async function installTaskCancellationFixture(pool: SqlPool) {
  const connection = await pool.connect();
  try {
    for (const statement of [
      'ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_constraint_1',
      'ALTER TABLE task_runs DROP CONSTRAINT task_runs_constraint_2',
      'ALTER TABLE task_runs DROP CONSTRAINT task_runs_constraint_8',
      'ALTER TABLE conversation_delivery_events DROP CONSTRAINT conversation_delivery_events_constraint_3',
      'ALTER TABLE task_run_delivery_receipts DROP CONSTRAINT task_run_delivery_receipts_constraint_1',
    ])
      await connection.query(statement);
  } finally {
    connection.release();
  }
}

export async function groupCancellationFixture(cleanup: Array<() => Promise<unknown>>) {
  const f = await taskFixture(cleanup);
  const member = await f.addUser(),
    admin = await f.addUser(),
    otherMember = await f.addUser();
  const groups = new GroupService(new PostgresGroupRepository(f.pool));
  const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
    name: 'Cancellation group',
  });
  // Cancellation trees are not COL-13 evidence; keep the default group cap
  // from starving sibling and retry claims in these fixtures.
  await f.pool.query('UPDATE groups SET execution_policy=$2::jsonb WHERE id=$1', [
    group.id,
    JSON.stringify({ maxConcurrentRuns: 16 }),
  ]);
  for (const [userId, role] of [
    [member.id, 'member'],
    [admin.id, 'admin'],
    [otherMember.id, 'member'],
  ])
    await groups.addMember(f.owner.user.id, f.owner.workspace.id, group.id, { userId, role });
  const provider = await f.providers.inWorkspace(f.owner.workspace.id).save(f.owner.user.id, {
    name: 'Shared cancellation model',
    baseUrl: 'https://models.example/v1',
    modelId: 'shared-model',
    apiKey: 'cancellation-provider-secret',
    headers: {},
  });
  const bot = await new BotService(new PostgresBotRepository(f.pool)).create(
    f.owner.user.id,
    f.owner.workspace.id,
    {
      name: 'Shared helper',
      roleDescription: 'Assistant',
      instructions: 'Private cancellation instructions',
      modelBinding: {
        scope: { kind: 'workspace', id: f.owner.workspace.id },
        connectionId: provider.id,
        modelId: provider.modelId,
      },
    },
  );
  const grants = new GroupBotService(new PostgresGroupBotRepository(f.pool));
  const grant = await grants.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
    botId: bot.id,
    idempotencyKey: 'cancellation-invite',
  });
  const task = await f.tasks.submit(member.id, f.owner.workspace.id, grant.conversationId, {
    idempotencyKey: 'group-task',
    body: 'Explain the group evidence.',
    groupGrantId: grant.id,
  });
  await installTaskCancellationFixture(f.pool);
  return {
    ...f,
    member,
    admin,
    otherMember,
    groups,
    group,
    grants,
    grant,
    sharedBot: bot,
    sharedProvider: provider,
    groupTask: task,
  };
}

import { botAclFixture } from './bot-acl-fixture.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import type { ModelAdapter } from '../../src/providers/model-events.js';

export async function taskFixture(
  cleanup: Array<() => Promise<unknown>>,
  now = () => new Date(),
  options: {
    retryPolicy?: { maxAttemptsPerModel: number; maxRunsPerChain: number };
    fallbackModel?: boolean;
    submitInitialTask?: boolean;
  } = {},
) {
  const { submitInitialTask = true, ...aclOptions } = options;
  const f = await botAclFixture(cleanup, { now, ...aclOptions });
  const conversations = new ConversationService(new PostgresConversationRepository(f.pool, now));
  const conversation = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
    subject: { kind: 'direct-bot', id: f.bot.id },
  });
  const tasks = new TaskService(f.pool, now);
  const task = submitInitialTask
    ? await tasks.submit(f.owner.user.id, f.owner.workspace.id, conversation.id, {
        idempotencyKey: 'initial-task',
        body: 'Explain the evidence.',
      })
    : undefined;
  return {
    ...f,
    tasks,
    task,
    conversations,
    conversation,
    read: () => {
      if (!task) throw new Error('taskFixture was created without an initial Task');
      return tasks.get(f.owner.user.id, f.owner.workspace.id, conversation.id, task.id);
    },
    worker: (generate: ModelAdapter['generate']) =>
      new TaskWorker(
        f.pool,
        {
          secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
          createAdapter: () => ({ generate }),
        },
        now,
      ),
  };
}

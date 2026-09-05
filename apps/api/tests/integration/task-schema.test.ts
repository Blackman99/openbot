import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('rejects a Task whose trigger belongs to another conversation', async () => {
  const f = await taskFixture(cleanup);
  const otherUser = await f.addUser();
  const otherConversationId = randomUUID();
  await f.pool.query(
    'INSERT INTO conversations(id,workspace_id,bot_id,creator_user_id,created_at) VALUES($1,$2,$3,$4,NOW())',
    [otherConversationId, f.owner.workspace.id, f.bot.id, otherUser.id],
  );
  const eventId = randomUUID();
  await f.pool.query(
    "INSERT INTO conversation_events(id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,idempotency_key,command_hash) VALUES($1,$2,1,$3,1,'message.created',$4,NOW(),'Other conversation','other',$5)",
    [eventId, otherConversationId, randomUUID(), f.owner.user.id, 'a'.repeat(64)],
  );
  await expect(
    f.pool.query(
      "INSERT INTO tasks(id,workspace_id,conversation_id,bot_id,bot_version_id,execution_user_id,trigger_event_id,command_hash,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',NOW())",
      [
        randomUUID(),
        f.owner.workspace.id,
        f.conversation.id,
        f.bot.id,
        f.bot.currentVersion.id,
        f.owner.user.id,
        eventId,
        'b'.repeat(64),
      ],
    ),
  ).rejects.toThrow(/foreign key/iu);
});

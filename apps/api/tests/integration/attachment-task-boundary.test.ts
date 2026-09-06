import { afterEach, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { AttachmentService } from '../../src/attachments/service.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('rejects purging a plain Task trigger, preserves its command identity, and lets the queued Task finish', async () => {
  const f = await taskFixture(cleanup);
  const trigger = (
    await f.pool.query(
      "SELECT message_id,body,command_hash FROM conversation_events WHERE conversation_id=$1 AND event_type='message.created'",
      [f.conversation.id],
    )
  ).rows[0]!;
  const attachments = new AttachmentService(f.pool, {
    identity: 'no-file-store',
    save: async () => {
      throw new Error('unexpected IO');
    },
    read: async () => {
      throw new Error('unexpected IO');
    },
    delete: async () => {
      throw new Error('unexpected IO');
    },
  });
  await expect(
    attachments.purge(
      {
        actorUserId: f.owner.user.id,
        workspaceId: f.owner.workspace.id,
        conversationId: f.conversation.id,
      },
      trigger.message_id,
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        'SELECT body,command_hash FROM conversation_events WHERE conversation_id=$1',
        [f.conversation.id],
      )
    ).rows,
  ).toEqual([{ body: trigger.body, command_hash: trigger.command_hash }]);
  expect((await f.pool.query('SELECT message_id FROM message_purges')).rows).toHaveLength(0);
  expect(
    await f
      .worker(async () => ({
        events: [
          { type: 'text', text: 'Task can finish.' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      }))
      .runOnce(),
  ).toBe(true);
  expect(await f.read()).toMatchObject({ status: 'completed', runs: [{ status: 'completed' }] });
});

import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { cleanupConversationStreams } from '../../src/conversations/stream-cleanup.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('idle conversation delivery retention', () => {
  it('reclaims an expired idle prefix without needing another append or touching source history', async () => {
    const f = await taskFixture(cleanup);
    const now = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await cleanupConversationStreams(f.pool, now)).toBe(1);
    const state = (
      await f.pool.query('SELECT * FROM conversation_delivery_state WHERE conversation_id=$1', [
        f.conversation.id,
      ])
    ).rows[0];
    expect(state).toMatchObject({ retained_count: 0, retained_bytes: 0 });
    expect(Number(state.floor)).toBe(2);
    expect(
      (
        await f.pool.query('SELECT id FROM conversation_events WHERE conversation_id=$1', [
          f.conversation.id,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(await cleanupConversationStreams(f.pool, now)).toBe(0);
  });
});

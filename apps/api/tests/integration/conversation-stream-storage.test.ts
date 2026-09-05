import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { migrateDatabase, MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import { appendQueuedRunState } from '../../src/conversations/append-event.js';
import { reclaimConversationStream } from '../../src/conversations/stream-retention.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('durable conversation delivery storage', () => {
  it('does not publish a transition twice after its delivery prefix was reclaimed', async () => {
    const f = await taskFixture(cleanup),
      connection = await f.pool.connect();
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
        f.owner.workspace.id,
      ]);
      await connection.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [f.bot.id]);
      await connection.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
        f.conversation.id,
      ]);
      await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [f.task.id]);
      await connection.query('SELECT id FROM task_runs WHERE id=$1 FOR UPDATE', [
        f.task.runs[0]!.id,
      ]);
      await reclaimConversationStream(connection, f.conversation.id, later);
      await appendQueuedRunState(connection, f.task.runs[0]!.id, () => later);
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
    expect(
      (
        await f.pool.query('SELECT last_sequence FROM conversations WHERE id=$1', [
          f.conversation.id,
        ])
      ).rows[0]?.last_sequence,
    ).toBe(2);
    expect(
      (
        await f.pool.query(
          'SELECT sequence FROM conversation_delivery_events WHERE conversation_id=$1',
          [f.conversation.id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('mirrors ledger references at their existing sequence without retaining the message text', async () => {
    const f = await taskFixture(cleanup);
    const receipt = await f.conversations.append(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      {
        idempotencyKey: 'stream-reference',
        body: 'historical text must stay in the source ledger',
      },
    );
    const revised = await f.conversations.edit(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      receipt.messageId,
      {
        idempotencyKey: 'stream-edit',
        expectedVersion: 1,
        body: 'current text',
      },
    );
    const events = (
      await f.pool.query(
        'SELECT * FROM conversation_delivery_events WHERE conversation_id=$1 ORDER BY sequence',
        [f.conversation.id],
      )
    ).rows;
    expect(
      events.filter((row) => [receipt.eventId, revised.eventId].includes(row.ledger_event_id)),
    ).toMatchObject([
      {
        sequence: receipt.sequence,
        event_type: 'message.changed',
        ledger_event_id: receipt.eventId,
      },
      {
        sequence: revised.sequence,
        event_type: 'message.changed',
        ledger_event_id: revised.eventId,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/historical text|current text/u);
    const counter = (
      await f.pool.query('SELECT last_sequence FROM conversations WHERE id=$1', [f.conversation.id])
    ).rows[0];
    const state = (
      await f.pool.query('SELECT * FROM conversation_delivery_state WHERE conversation_id=$1', [
        f.conversation.id,
      ])
    ).rows[0];
    expect(Number(state.floor)).toBe(0);
    expect(Number(state.retained_count)).toBe(Number(counter.last_sequence));
  });

  it.each([
    'CREATE FUNCTION protect_conversation_delivery',
    'CREATE CONSTRAINT TRIGGER conversations_delivery_prefix',
  ])('rolls back migration0019 when mandatory %s cannot be installed', async (guard) => {
    const statements: string[] = [];
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        if (statement.includes(guard)) throw new Error('delivery guard installation failed');
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? {
              rows: MIGRATION_VERSIONS.slice(
                0,
                MIGRATION_VERSIONS.indexOf('0019_conversation_delivery'),
              ).map((version) => ({ version })),
            }
          : { rows: [] };
      },
      release: () => undefined,
    };
    await expect(migrateDatabase({ connect: async () => connection })).rejects.toThrow(
      'delivery guard installation failed',
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(
      statements.some((statement) => statement.startsWith('INSERT INTO openbot_schema_migrations')),
    ).toBe(false);
  });
});

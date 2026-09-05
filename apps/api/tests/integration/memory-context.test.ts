import { afterEach, describe, expect, it } from 'vitest';
import { memoryFixture } from '../helpers/memory-fixture.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import {
  selectRunMemoryContribution,
  persistRunMemoryReferences,
  assertRunMemoryReferencesCurrent,
} from '../../src/memories/run-context.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(history: 'all' | 'future-only' = 'all') {
  const f = await memoryFixture(cleanup);
  const saved = await f.memories.create(
    { actorUserId: f.owner.user.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
    f.command,
  );
  const grant = await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
    botId: f.bot.id,
    idempotencyKey: 'invite',
    history: { mode: history },
  });
  const tasks = new TaskService(f.pool);
  const task = await tasks.submit(f.owner.user.id, f.owner.workspace.id, f.conversation.id, {
    idempotencyKey: 'run',
    body: 'Use the authorized saved memories.',
    groupGrantId: grant.id,
  });
  return { ...f, saved: saved.memory, tasks, task, grant, runId: task.runs[0]!.id };
}
describe('identified memory context contribution', () => {
  it('selects a dedicated provenance-bearing block with exact byte and item accounting', async () => {
    const f = await fixture(),
      connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      const contribution = await selectRunMemoryContribution(connection, f.runId);
      expect(contribution.references).toEqual([
        { memoryVersionId: f.saved.versionId, sourceEventId: f.source.eventId },
      ]);
      expect(contribution.itemCount).toBe(1);
      expect(contribution.messages).toHaveLength(1);
      expect(contribution.messages[0]!.role).toBe('user');
      expect(JSON.parse(contribution.messages[0]!.content)).toMatchObject({
        kind: 'group_memories',
        memories: [
          {
            id: f.saved.id,
            text: f.saved.text,
            source: { eventId: f.source.eventId },
            confidenceSource: 'human',
          },
        ],
      });
      expect(contribution.bytes).toBe(Buffer.byteLength(contribution.messages[0]!.content));
      await expect(persistRunMemoryReferences(connection, contribution)).rejects.toThrow();
      expect((await connection.query('SELECT run_id FROM run_memory_references')).rows).toEqual([]);
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
  });
  it('does not derive context across a source history boundary or from sources created after the trigger horizon', async () => {
    const f = await fixture('future-only');
    const later = await f.conversations.append(
      f.owner.user.id,
      f.owner.workspace.id,
      f.conversation.id,
      { body: 'After the trigger horizon', idempotencyKey: 'later' },
    );
    await f.memories.create(
      { actorUserId: f.owner.user.id, workspaceId: f.owner.workspace.id, groupId: f.group.id },
      {
        ...f.command,
        idempotencyKey: 'save-later',
        messageId: later.messageId,
        expectedSourceEventId: later.eventId,
      },
    );
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      expect(await selectRunMemoryContribution(connection, f.runId)).toMatchObject({
        messages: [],
        references: [],
        itemCount: 0,
        bytes: 0,
      });
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
  });
  it('persists only locators after claim and rejects a stale manifest before subsequent publication', async () => {
    const f = await fixture(),
      connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      const contribution = await selectRunMemoryContribution(connection, f.runId);
      await connection.query('COMMIT');
      // The integrated queue records exactly the selected source locators after its CAS.
      expect((await new TaskQueue(f.pool).claimNext()).claim?.runId).toBe(f.runId);
      await connection.query('BEGIN');
      expect(
        (
          await connection.query(
            'SELECT memory_version_id FROM run_memory_references WHERE run_id=$1',
            [f.runId],
          )
        ).rows,
      ).toEqual(
        contribution.references.map((reference) => ({
          memory_version_id: reference.memoryVersionId,
        })),
      );
      await assertRunMemoryReferencesCurrent(connection, f.runId);
      await connection.query('COMMIT');
      const rows = (await f.pool.query('SELECT * FROM run_memory_references')).rows;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(f.saved.text);
      await f.conversations.edit(
        f.owner.user.id,
        f.owner.workspace.id,
        f.conversation.id,
        f.source.messageId,
        {
          idempotencyKey: 'changed',
          expectedVersion: 1,
          body: 'Source revised during provider work',
        },
      );
      await connection.query('BEGIN');
      await expect(assertRunMemoryReferencesCurrent(connection, f.runId)).rejects.toThrow();
      await connection.query('ROLLBACK');
      expect((await f.pool.query('SELECT * FROM run_memory_references')).rows).toEqual(rows);
    } finally {
      connection.release();
    }
  });
  it('rechecks the persisted Task human and exact closed grant rather than a replacement', async () => {
    const f = await fixture();
    await f.grants.remove(f.owner.user.id, f.owner.workspace.id, f.group.id, f.grant.id, {
      idempotencyKey: 'remove',
    });
    await f.grants.invite(f.owner.user.id, f.owner.workspace.id, f.group.id, {
      botId: f.bot.id,
      idempotencyKey: 'replacement',
      history: { mode: 'all' },
    });
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      await expect(selectRunMemoryContribution(connection, f.runId)).rejects.toThrow();
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupBotTransaction } from '../../src/group-bots/postgres-admission.js';
import { ConversationService } from '../../src/conversations/service.js';
import {
  ConversationTransaction,
  PostgresConversationRepository,
} from '../../src/conversations/postgres-repository.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await botAclFixture(cleanup);
  const groups = new GroupService(new PostgresGroupRepository(f.pool));
  const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
    name: 'Memory sources',
  });
  const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
  const conversation = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
    subject: { kind: 'group', id: group.id },
  });
  const access = {
    actorUserId: f.owner.user.id,
    workspaceId: f.owner.workspace.id,
    conversationId: conversation.id,
  };
  return { ...f, groups, group, conversations, conversation, access };
}
describe('current memory source admission', () => {
  it('returns only current visible text with original and current event provenance, then denies a tombstone', async () => {
    const f = await fixture();
    const first = await f.conversations.append(
      f.access.actorUserId,
      f.access.workspaceId,
      f.access.conversationId,
      { idempotencyKey: 'first', body: 'Old source' },
    );
    const edited = await f.conversations.edit(
      f.access.actorUserId,
      f.access.workspaceId,
      f.access.conversationId,
      first.messageId,
      { idempotencyKey: 'edit', body: 'Current source', expectedVersion: 1 },
    );
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      const admitted = await ConversationTransaction.lock(connection, f.access);
      expect(await admitted.sourceForMemory(first.messageId)).toMatchObject({
        conversationId: f.conversation.id,
        groupId: f.group.id,
        messageId: first.messageId,
        creationEventId: first.eventId,
        creationSequence: first.sequence,
        versionEventId: edited.eventId,
        version: 2,
        body: 'Current source',
        author: { id: f.owner.user.id },
      });
      await connection.query('COMMIT');
      await f.conversations.tombstone(
        f.access.actorUserId,
        f.access.workspaceId,
        f.access.conversationId,
        first.messageId,
        { idempotencyKey: 'delete', expectedVersion: 2 },
      );
      await connection.query('BEGIN');
      await expect(
        (await ConversationTransaction.lock(connection, f.access)).sourceForMemory(first.messageId),
      ).rejects.toThrow();
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
  });
  it('applies the exact grant to original creation before selecting a later edited source', async () => {
    const f = await fixture();
    const before = await f.conversations.append(
      f.access.actorUserId,
      f.access.workspaceId,
      f.access.conversationId,
      { idempotencyKey: 'before', body: 'Before grant' },
    );
    const bots = new GroupBotService(new PostgresGroupBotRepository(f.pool));
    const grant = await bots.invite(f.access.actorUserId, f.access.workspaceId, f.group.id, {
      botId: f.bot.id,
      idempotencyKey: 'invite',
    });
    const after = await f.conversations.append(
      f.access.actorUserId,
      f.access.workspaceId,
      f.access.conversationId,
      { idempotencyKey: 'after', body: 'After grant' },
    );
    await f.conversations.edit(
      f.access.actorUserId,
      f.access.workspaceId,
      f.access.conversationId,
      before.messageId,
      { idempotencyKey: 'late', expectedVersion: 1, body: 'Late edit cannot open history' },
    );
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      const admitted = await GroupBotTransaction.lock(connection, {
        ...f.access,
        groupId: f.group.id,
        grantId: grant.id,
      });
      await expect(admitted.sourceForMemory(before.messageId)).rejects.toThrow();
      expect(await admitted.sourceForMemory(after.messageId)).toMatchObject({
        creationSequence: after.sequence,
        body: 'After grant',
      });
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
  });
  it('does not admit a creator-private direct message as group memory', async () => {
    const f = await fixture();
    const direct = await f.conversations.open(f.access.actorUserId, f.access.workspaceId, {
      subject: { kind: 'direct-bot', id: f.bot.id },
    });
    const source = await f.conversations.append(
      f.access.actorUserId,
      f.access.workspaceId,
      direct.id,
      { idempotencyKey: 'private', body: 'Private text' },
    );
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      await expect(
        (
          await ConversationTransaction.lock(connection, { ...f.access, conversationId: direct.id })
        ).sourceForMemory(source.messageId),
      ).rejects.toThrow();
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
  });
});

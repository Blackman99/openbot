import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('attachment message authorization', () => {
  it('pins exact active grant and original creation lower bound across late edits, removal, and reinvitation', async () => {
    const f = await botAclFixture(cleanup);
    const member = await f.addUser();
    const groups = new GroupService(new PostgresGroupRepository(f.pool));
    const group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
      name: 'Attachment history',
    });
    await groups.addMember(f.owner.user.id, f.owner.workspace.id, group.id, {
      userId: member.id,
      role: 'member',
    });
    const bots = new GroupBotService(new PostgresGroupBotRepository(f.pool));
    const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
    const conversation = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
      subject: { kind: 'group', id: group.id },
    });
    const root = await mkdtemp(join(tmpdir(), 'openbot-history-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const attachments = new AttachmentService(f.pool, new LocalObjectStore(root));
    const access = {
      actorUserId: f.owner.user.id,
      workspaceId: f.owner.workspace.id,
      conversationId: conversation.id,
    };
    const bytes = Buffer.from('Private conversation file');
    const command = {
      body: 'File',
      filename: 'file.txt',
      mediaType: 'text/plain',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      idempotencyKey: 'before',
    };
    const before = await attachments.upload(access, command, bytes);
    const grant = await bots.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
      botId: f.bot.id,
      idempotencyKey: 'invite',
    });
    const grantAccess = {
      actorUserId: member.id,
      workspaceId: f.owner.workspace.id,
      groupId: group.id,
      grantId: grant.id,
    };
    const after = await attachments.upload(access, { ...command, idempotencyKey: 'after' }, bytes);
    await conversations.edit(
      f.owner.user.id,
      f.owner.workspace.id,
      conversation.id,
      before.messageId,
      { body: 'Edited late', idempotencyKey: 'late-edit', expectedVersion: 1 },
    );
    expect((await attachments.readGroup(grantAccess, after.messageId)).bytes).toEqual(bytes);
    await expect(attachments.readGroup(grantAccess, before.messageId)).rejects.toThrow();
    await bots.remove(f.owner.user.id, f.owner.workspace.id, group.id, grant.id, {
      idempotencyKey: 'remove',
    });
    const interval = await attachments.upload(
      access,
      { ...command, idempotencyKey: 'interval' },
      bytes,
    );
    await expect(attachments.readGroup(grantAccess, interval.messageId)).rejects.toThrow();
    await expect(attachments.readGroup(grantAccess, after.messageId)).rejects.toThrow();
    const fresh = await bots.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
      botId: f.bot.id,
      idempotencyKey: 'reinvite',
    });
    await expect(
      attachments.readGroup({ ...grantAccess, grantId: fresh.id }, interval.messageId),
    ).rejects.toThrow();
    const latest = await attachments.upload(
      access,
      { ...command, idempotencyKey: 'latest' },
      bytes,
    );
    expect(
      (await attachments.readGroup({ ...grantAccess, grantId: fresh.id }, latest.messageId)).bytes,
    ).toEqual(bytes);
    await groups.removeMember(f.owner.user.id, f.owner.workspace.id, group.id, member.id);
    await expect(
      attachments.readGroup({ ...grantAccess, grantId: fresh.id }, latest.messageId),
    ).rejects.toThrow();
  });
  it('keeps direct conversation attachments creator-private and denies stale grantor authority', async () => {
    const f = await botAclFixture(cleanup),
      other = await f.addUser();
    await f.app.inject({
      method: 'POST',
      url: `${f.path}/${f.bot.id}/acl`,
      headers: f.headers,
      payload: { userId: other.id, role: 'user' },
    });
    const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
    const direct = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
      subject: { kind: 'direct-bot', id: f.bot.id },
    });
    const root = await mkdtemp(join(tmpdir(), 'openbot-direct-file-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const attachments = new AttachmentService(f.pool, new LocalObjectStore(root));
    const bytes = Buffer.from('Private creator file'),
      command = {
        body: 'Private',
        filename: 'private.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        idempotencyKey: 'private',
      };
    const access = {
      actorUserId: f.owner.user.id,
      workspaceId: f.owner.workspace.id,
      conversationId: direct.id,
    };
    const receipt = await attachments.upload(access, command, bytes);
    await expect(
      attachments.metadata({ ...access, actorUserId: other.id }, receipt.messageId),
    ).rejects.toThrow();
    const groups = new GroupService(new PostgresGroupRepository(f.pool)),
      group = await groups.create(f.owner.user.id, f.owner.workspace.id, {
        name: 'Grantor authority',
      });
    await groups.addMember(f.owner.user.id, f.owner.workspace.id, group.id, {
      userId: other.id,
      role: 'member',
    });
    const bots = new GroupBotService(new PostgresGroupBotRepository(f.pool));
    const grant = await bots.invite(f.owner.user.id, f.owner.workspace.id, group.id, {
      botId: f.bot.id,
      idempotencyKey: 'invite',
    });
    const groupReceipt = await attachments.upload(
      { ...access, conversationId: grant.conversationId },
      { ...command, idempotencyKey: 'group-file' },
      bytes,
    );
    const grantAccess = {
      actorUserId: other.id,
      workspaceId: f.owner.workspace.id,
      groupId: group.id,
      grantId: grant.id,
    };
    expect((await attachments.readGroup(grantAccess, groupReceipt.messageId)).bytes).toEqual(bytes);
    await f.pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
      f.owner.workspace.id,
      f.owner.user.id,
    ]);
    await expect(attachments.readGroup(grantAccess, groupReceipt.messageId)).rejects.toThrow();
  });
});

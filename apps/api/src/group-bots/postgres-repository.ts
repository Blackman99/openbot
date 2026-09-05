import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { lockAuthorizedBot } from '../bots/postgres-bot-access.js';
import { BotAccessError, type BotConfiguration } from '../bots/service.js';
import { GroupAccessError } from '../groups/service.js';
import { openGroupMembershipConversation } from '../conversations/postgres-repository.js';
import { appendBotJoined } from '../conversations/append-event.js';
import { closeGroupBotGrant } from './postgres-closures.js';
import { InvalidConversationInputError, type MessageRead } from '../conversations/service.js';
import { GroupBotTransaction } from './postgres-admission.js';
import {
  GroupBotAccessError,
  GroupBotInputError,
  GroupBotConflictError,
  type GroupBotAccess,
  type GroupBotGrant,
  type GroupBotInvite,
  type GroupBotHistory,
  type GroupBotClosureReason,
  type GroupBotRepository,
} from './service.js';

type GrantRow = {
  id: string;
  group_id: string;
  bot_id: string;
  conversation_id: string;
  granted_by_user_id: string;
  grantor_name: string;
  configuration: BotConfiguration;
  viewer_role: string | null;
  history_mode: GroupBotHistory['mode'];
  source_event_id: string | null;
  source_time: Date | null;
  lower_bound: number | string;
  join_event_id: string;
  join_sequence: number | string;
  joined_at: Date;
  close_event_id: string | null;
  close_sequence: string | number | null;
  closed_at: Date | null;
  closure_reason: GroupBotClosureReason | null;
};
export async function readGroupBotGrants(
  connection: SqlConnection,
  access: GroupBotAccess,
): Promise<GroupBotGrant[]> {
  const rows = (
    await connection.query<GrantRow>(
      `SELECT g.*,u.display_name AS grantor_name,v.configuration,a.role AS viewer_role FROM group_bot_grants g
     INNER JOIN users u ON u.id=g.granted_by_user_id INNER JOIN bots b ON b.id=g.bot_id
     INNER JOIN bot_versions v ON v.id=b.current_version_id AND v.bot_id=b.id
     LEFT JOIN bot_acl a ON a.bot_id=b.id AND a.user_id=$3
     WHERE g.workspace_id=$1 AND g.group_id=$2 ORDER BY g.join_sequence,g.id`,
      [access.workspaceId, access.groupId, access.actorUserId],
    )
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    conversationId: row.conversation_id,
    bot: {
      id: row.bot_id,
      name: row.configuration.name,
      roleDescription: row.configuration.roleDescription,
      description: row.configuration.description,
      canInspect: row.viewer_role !== null,
    },
    grantedBy: { id: row.granted_by_user_id, displayName: row.grantor_name },
    history: {
      ...(row.history_mode === 'since-event'
        ? { mode: row.history_mode, eventId: row.source_event_id! }
        : row.history_mode === 'since-time'
          ? { mode: row.history_mode, time: row.source_time!.toISOString() }
          : { mode: row.history_mode }),
      lowerBound: Number(row.lower_bound),
    },
    joined: { eventId: row.join_event_id, sequence: Number(row.join_sequence), at: row.joined_at },
    closed: row.close_event_id
      ? {
          eventId: row.close_event_id,
          sequence: Number(row.close_sequence),
          at: row.closed_at!,
          reason: row.closure_reason!,
        }
      : null,
  }));
}
export class PostgresGroupBotRepository implements GroupBotRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async transaction<T>(operation: (connection: SqlConnection) => Promise<T>) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      if (error instanceof GroupAccessError || error instanceof BotAccessError)
        throw new GroupBotAccessError();
      if (error instanceof InvalidConversationInputError) throw new GroupBotInputError();
      throw error;
    } finally {
      connection.release();
    }
  }
  list(access: GroupBotAccess) {
    return this.transaction(async (connection) => {
      const group = await lockAuthorizedGroup(
        connection,
        { actorId: access.actorUserId, workspaceId: access.workspaceId, groupId: access.groupId },
        'content',
      );
      const grants = await readGroupBotGrants(connection, access);
      return {
        groupId: group.id,
        grants,
        activeCount: grants.filter((grant) => !grant.closed).length,
        maxActive: 8,
        canManage: group.role !== 'member',
      };
    });
  }
  context(access: GroupBotAccess, grantId: string, read: MessageRead) {
    return this.transaction(async (connection) =>
      (await GroupBotTransaction.lock(connection, { ...access, grantId })).context(read),
    );
  }
  remove(access: GroupBotAccess, grantId: string, idempotencyKey: string) {
    return this.transaction(async (connection) => {
      await lockAuthorizedGroup(
        connection,
        { actorId: access.actorUserId, workspaceId: access.workspaceId, groupId: access.groupId },
        'manage',
      );
      const grant = (await readGroupBotGrants(connection, access)).find(
        (grant) => grant.id === grantId,
      );
      if (!grant) throw new GroupBotAccessError();
      await connection.query('SELECT id FROM bots WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        access.workspaceId,
        grant.bot.id,
      ]);
      const hash = createHash('sha256')
        .update(JSON.stringify({ type: 'bot.removed', grantId, reason: 'removed' }))
        .digest('hex');
      const prior = (
        await connection.query<{ command_hash: string }>(
          'SELECT command_hash FROM conversation_events WHERE conversation_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
          [grant.conversationId, access.actorUserId, idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.command_hash !== hash) throw new GroupBotConflictError('idempotency_conflict');
        return grant;
      }
      if (grant.closed) throw new GroupBotConflictError('group_bot_inactive');
      await closeGroupBotGrant(
        connection,
        access.actorUserId,
        {
          id: grant.id,
          workspaceId: access.workspaceId,
          groupId: access.groupId,
          botId: grant.bot.id,
          conversationId: grant.conversationId,
          grantorUserId: grant.grantedBy.id,
        },
        'removed',
        { idempotencyKey, hash },
        this.now,
      );
      return (await readGroupBotGrants(connection, access)).find((grant) => grant.id === grantId)!;
    });
  }
  invite(access: GroupBotAccess, command: GroupBotInvite) {
    return this.transaction(async (connection) => {
      await lockAuthorizedGroup(
        connection,
        { actorId: access.actorUserId, workspaceId: access.workspaceId, groupId: access.groupId },
        'manage',
      );
      await lockAuthorizedBot(
        connection,
        { actorUserId: access.actorUserId, workspaceId: access.workspaceId, botId: command.botId },
        'use',
      );
      const conversation = await openGroupMembershipConversation(
        connection,
        access.actorUserId,
        access.workspaceId,
        access.groupId,
        this.now,
      );
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            type: 'bot.joined',
            botId: command.botId,
            history: command.history,
          }),
        )
        .digest('hex');
      const prior = (
        await connection.query<{ membership_id: string; command_hash: string }>(
          'SELECT membership_id,command_hash FROM conversation_events WHERE conversation_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
          [conversation.id, access.actorUserId, command.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.command_hash !== hash) throw new GroupBotConflictError('idempotency_conflict');
        return (await readGroupBotGrants(connection, access)).find(
          (grant) => grant.id === prior.membership_id,
        )!;
      }
      const active = (
        await connection.query<{ bot_id: string }>(
          'SELECT bot_id FROM group_bot_grants WHERE workspace_id=$1 AND group_id=$2 AND close_event_id IS NULL',
          [access.workspaceId, access.groupId],
        )
      ).rows;
      if (active.some((grant) => grant.bot_id === command.botId))
        throw new GroupBotConflictError('group_bot_already_active');
      if (active.length >= 8) throw new GroupBotConflictError('group_bot_limit');
      let lowerBound: number | null = command.history.mode === 'all' ? 1 : null;
      if (command.history.mode === 'since-event') {
        const event = (
          await connection.query<{ sequence: string | number }>(
            'SELECT sequence FROM conversation_events WHERE conversation_id=$1 AND id=$2',
            [conversation.id, command.history.eventId],
          )
        ).rows[0];
        if (!event) throw new GroupBotInputError();
        lowerBound = Number(event.sequence);
      } else if (command.history.mode === 'since-time') {
        if (Date.parse(command.history.time) > this.now().getTime()) throw new GroupBotInputError();
        const event = (
          await connection.query<{ sequence: string | number }>(
            'SELECT sequence FROM conversation_events WHERE conversation_id=$1 AND occurred_at >= $2 ORDER BY sequence LIMIT 1',
            [conversation.id, command.history.time],
          )
        ).rows[0];
        lowerBound = event ? Number(event.sequence) : null;
      }
      const grantId = randomUUID();
      const receipt = await appendBotJoined(
        connection,
        { ...access, conversationId: conversation.id },
        { ...command, hash, groupId: access.groupId, grantId, lowerBound },
        this.now,
      );
      await connection.query(
        'INSERT INTO group_bot_grants(id,workspace_id,group_id,bot_id,conversation_id,granted_by_user_id,history_mode,lower_bound,join_event_id,join_sequence,joined_at,source_event_id,source_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          grantId,
          access.workspaceId,
          access.groupId,
          command.botId,
          conversation.id,
          access.actorUserId,
          command.history.mode,
          lowerBound ?? receipt.sequence,
          receipt.eventId,
          receipt.sequence,
          receipt.occurredAt,
          command.history.mode === 'since-event' ? command.history.eventId : null,
          command.history.mode === 'since-time' ? command.history.time : null,
        ],
      );
      return (await readGroupBotGrants(connection, access)).find((grant) => grant.id === grantId)!;
    });
  }
}

import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { ConversationAccess, MessageVersion } from './service.js';
import type { GroupBotHistory, GroupBotClosureReason } from '../group-bots/service.js';

interface Command {
  idempotencyKey: string;
  hash: string;
}
interface MessageEvent extends Command {
  messageId: string;
  version: number;
  type: MessageVersion['type'];
  body: string | null;
  reason: string | null;
}
interface StoredEvent {
  type: string;
  messageId: string | null;
  version: number | null;
  membershipId: string | null;
  body: string | null;
  reason: string | null;
  data: object;
  auditType: string;
  audit: object;
  botRunId?: string;
}
// Only the typed message/membership writers below can reach the allocator.
// Each allocation always inserts its event and mandatory audit in the same TX.
async function append(
  connection: SqlConnection,
  access: Readonly<ConversationAccess>,
  command: Command,
  now: () => Date,
  event: (receipt: { eventId: string; sequence: number }) => StoredEvent,
) {
  const row = (
    await connection.query<{ last_sequence: string | number }>(
      'UPDATE conversations SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING last_sequence',
      [access.conversationId],
    )
  ).rows[0]!;
  const receipt = { eventId: randomUUID(), sequence: Number(row.last_sequence) };
  const occurredAt = now();
  const value = event(receipt);
  await connection.query(
    `INSERT INTO conversation_events(id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,reason,idempotency_key,command_hash,membership_id,event_data${value.botRunId ? ',bot_run_id' : ''}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb${value.botRunId ? ',$15' : ''})`,
    [
      receipt.eventId,
      access.conversationId,
      receipt.sequence,
      value.messageId,
      value.version,
      value.type,
      access.actorUserId,
      occurredAt,
      value.body,
      value.reason,
      command.idempotencyKey,
      command.hash,
      value.membershipId,
      JSON.stringify(value.data),
      ...(value.botRunId ? [value.botRunId] : []),
    ],
  );
  await connection.query(
    'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [
      randomUUID(),
      value.auditType,
      access.actorUserId,
      occurredAt,
      JSON.stringify({
        workspaceId: access.workspaceId,
        conversationId: access.conversationId,
        ...value.audit,
      }),
    ],
  );
  return { ...receipt, occurredAt };
}

// Only a currently running, unexpired claim can append Bot output. Canonical
// author/scope/version come from that retained Task, never caller-supplied IDs.
export async function appendBotResult(
  connection: SqlConnection,
  command: { runId: string; claimToken: string; body: string },
  now: () => Date,
) {
  if (
    !command.body.trim() ||
    command.body.length > 32000 ||
    Buffer.byteLength(command.body) > 128000
  )
    throw new Error('Invalid Bot output');
  const row = (
    await connection.query<{
      id: string;
      workspace_id: string;
      conversation_id: string;
      execution_user_id: string;
      bot_id: string;
      bot_version_id: string;
      configuration: { name: string };
      version: number;
      deadline_at: Date;
    }>(
      `SELECT t.*,v.configuration,v.version,r.deadline_at FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN bot_versions v ON v.id=t.bot_version_id AND v.bot_id=t.bot_id WHERE r.id=$1 AND r.claim_token=$2 AND r.status='running'`,
      [command.runId, command.claimToken],
    )
  ).rows[0];
  if (!row || row.deadline_at.getTime() <= now().getTime()) return undefined;
  const messageId = randomUUID();
  const bot = {
    id: row.bot_id,
    displayName: row.configuration.name,
    versionId: row.bot_version_id,
    versionNumber: row.version,
  };
  const receipt = await append(
    connection,
    {
      actorUserId: row.execution_user_id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
    },
    {
      // Run uniqueness and claim fencing provide durable deduplication. A
      // server-generated command key cannot be preoccupied by a human command.
      idempotencyKey: `bot-output:${randomUUID()}`,
      hash: createHash('sha256')
        .update(
          JSON.stringify({ type: 'bot.message.created', runId: command.runId, body: command.body }),
        )
        .digest('hex'),
    },
    now,
    (receipt) => ({
      type: 'bot.message.created',
      messageId,
      version: 1,
      membershipId: null,
      body: command.body,
      reason: null,
      botRunId: command.runId,
      data: { bot, taskId: row.id, runId: command.runId },
      auditType: 'conversation.bot_message_created',
      audit: {
        taskId: row.id,
        runId: command.runId,
        botId: row.bot_id,
        botVersionId: row.bot_version_id,
        messageId,
        ...receipt,
      },
    }),
  );
  return { messageId, eventId: receipt.eventId, sequence: receipt.sequence };
}
export async function appendMessageEvent(
  connection: SqlConnection,
  access: Readonly<ConversationAccess>,
  command: MessageEvent,
  now: () => Date,
) {
  const receipt = await append(connection, access, command, now, (receipt) => ({
    ...command,
    membershipId: null,
    data: {},
    auditType: `conversation.${command.type.replace('.', '_')}`,
    audit: { messageId: command.messageId, ...receipt },
  }));
  return { messageId: command.messageId, eventId: receipt.eventId, sequence: receipt.sequence };
}
export function appendBotJoined(
  connection: SqlConnection,
  access: Readonly<ConversationAccess>,
  command: Command & {
    groupId: string;
    botId: string;
    grantId: string;
    history: GroupBotHistory;
    lowerBound: number | null;
  },
  now: () => Date,
) {
  return append(connection, access, command, now, (receipt) => {
    const data = {
      groupId: command.groupId,
      botId: command.botId,
      grantId: command.grantId,
      history: { ...command.history, lowerBound: command.lowerBound ?? receipt.sequence },
    };
    return {
      type: 'bot.joined',
      messageId: null,
      version: null,
      membershipId: command.grantId,
      body: null,
      reason: null,
      data,
      auditType: 'group.bot_joined',
      audit: { ...data, ...receipt },
    };
  });
}
export function appendBotRemoved(
  connection: SqlConnection,
  access: Readonly<ConversationAccess>,
  command: Command & {
    groupId: string;
    botId: string;
    grantId: string;
    grantorUserId: string;
    reason: GroupBotClosureReason;
  },
  now: () => Date,
) {
  return append(connection, access, command, now, (receipt) => {
    const data = {
      groupId: command.groupId,
      botId: command.botId,
      grantId: command.grantId,
      grantorUserId: command.grantorUserId,
      reason: command.reason,
    };
    return {
      type: 'bot.removed',
      messageId: null,
      version: null,
      membershipId: command.grantId,
      body: null,
      reason: command.reason,
      data,
      auditType: 'group.bot_removed',
      audit: { ...data, ...receipt },
    };
  });
}

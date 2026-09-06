import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { ConversationAccess, MessageVersion } from './service.js';
import type { GroupBotHistory, GroupBotClosureReason } from '../group-bots/service.js';
import { reclaimConversationStream } from './stream-retention.js';
import { readRunExecution } from '../tasks/execution-state.js';
import { encodeConversationStreamEvent } from './stream-protocol.js';
import type { TaskStatus } from '../tasks/service.js';
import { checkpointTaskPartialOutput } from '../tasks/partial-output.js';
import { lockTaskAncestry } from '../tasks/tree.js';

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
  attachmentId?: string;
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
async function allocate(connection: SqlConnection, conversationId: string) {
  const row = (
    await connection.query<{ last_sequence: string | number }>(
      'UPDATE conversations SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING last_sequence',
      [conversationId],
    )
  ).rows[0]!;
  const sequence = Number(row.last_sequence);
  await connection.query(
    'INSERT INTO conversation_delivery_state(conversation_id,floor) VALUES($1,$2) ON CONFLICT(conversation_id) DO NOTHING',
    [conversationId, sequence - 1],
  );
  return sequence;
}
// These transition-specific writers derive immutable identities and safe data
// from the persisted Run. Caller owns workspace/group/Bot/conversation/Task/Run
// locks and the status + audit transaction; no caller-defined event writer.
async function appendRunState(
  connection: SqlConnection,
  runId: string,
  status: TaskStatus,
  now: () => Date,
) {
  const selected = await readRunExecution(connection, runId);
  if (
    !selected ||
    selected.execution.runStatus !== status ||
    selected.execution.taskStatus !== status
  )
    throw new Error('Run delivery transition does not match retained state');
  if (
    (
      await connection.query(
        'SELECT sequence FROM task_run_delivery_receipts WHERE run_id=$1 AND run_status=$2',
        [runId, status],
      )
    ).rows.length
  )
    return;
  const sequence = await allocate(connection, selected.conversationId),
    occurredAt = now();
  encodeConversationStreamEvent(selected, sequence, occurredAt, {
    type: 'task.run.updated',
    data: { execution: selected.execution },
  });
  const execution = JSON.stringify(selected.execution),
    byteSize = 2048 + 2 * Buffer.byteLength(execution);
  await connection.query(
    "INSERT INTO conversation_delivery_events(conversation_id,sequence,occurred_at,event_type,run_id,run_status,execution,byte_size) VALUES($1,$2,$3,'task.run.updated',$4,$5,$6::jsonb,$7)",
    [selected.conversationId, sequence, occurredAt, runId, status, execution, byteSize],
  );
  await connection.query(
    'INSERT INTO task_run_delivery_receipts(run_id,run_status,conversation_id,sequence) VALUES($1,$2,$3,$4)',
    [runId, status, selected.conversationId, sequence],
  );
  await reclaimConversationStream(connection, selected.conversationId, occurredAt);
}
export const appendQueuedRunState = (connection: SqlConnection, runId: string, now: () => Date) =>
  appendRunState(connection, runId, 'queued', now);
export const appendRunningRunState = (connection: SqlConnection, runId: string, now: () => Date) =>
  appendRunState(connection, runId, 'running', now);
export const appendCompletedRunState = (
  connection: SqlConnection,
  runId: string,
  now: () => Date,
) => appendRunState(connection, runId, 'completed', now);
export const appendFailedRunState = (connection: SqlConnection, runId: string, now: () => Date) =>
  appendRunState(connection, runId, 'failed', now);
export const appendCancelledRunState = (
  connection: SqlConnection,
  runId: string,
  now: () => Date,
) => appendRunState(connection, runId, 'cancelled', now);
export const appendPausedRunState = (connection: SqlConnection, runId: string, now: () => Date) =>
  appendRunState(connection, runId, 'paused', now);
export const appendWaitingChildRunState = (
  connection: SqlConnection,
  runId: string,
  now: () => Date,
) => appendRunState(connection, runId, 'waiting_child', now);
export const appendWaitingInputRunState = (
  connection: SqlConnection,
  runId: string,
  now: () => Date,
) => appendRunState(connection, runId, 'waiting_input', now);
export const appendWaitingApprovalRunState = (
  connection: SqlConnection,
  runId: string,
  now: () => Date,
) => appendRunState(connection, runId, 'waiting_approval', now);

export async function appendAssistantDelta(
  connection: SqlConnection,
  command: { runId: string; claimToken: string; text: string },
  now: () => Date,
) {
  const row = (
    await connection.query<{
      workspace_id: string;
      conversation_id: string;
      task_id: string;
      attempt: number;
      deadline_at: Date;
    }>(
      "SELECT t.workspace_id,t.conversation_id,r.task_id,r.attempt,r.deadline_at FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.claim_token=$2 AND r.status='running' AND t.status='running'",
      [command.runId, command.claimToken],
    )
  ).rows[0];
  if (!row || row.deadline_at.getTime() <= now().getTime()) return false;
  if (!(await lockTaskAncestry(connection, row.task_id))) return false;
  await connection.query(
    'INSERT INTO task_run_streams(run_id) VALUES($1) ON CONFLICT(run_id) DO NOTHING',
    [command.runId],
  );
  const progress = (
    await connection.query<{ delivered_bytes: number }>(
      'SELECT delivered_bytes FROM task_run_streams WHERE run_id=$1',
      [command.runId],
    )
  ).rows[0]!;
  const startByte = progress.delivered_bytes,
    endByte = startByte + Buffer.byteLength(command.text);
  const sequence = await allocate(connection, row.conversation_id),
    occurredAt = now();
  encodeConversationStreamEvent(
    { workspaceId: row.workspace_id, conversationId: row.conversation_id },
    sequence,
    occurredAt,
    {
      type: 'assistant.delta',
      data: {
        taskId: row.task_id,
        runId: command.runId,
        attempt: row.attempt,
        startByte,
        endByte,
        text: command.text,
      },
    },
  );
  await connection.query(
    "INSERT INTO conversation_delivery_events(conversation_id,sequence,occurred_at,event_type,run_id,delta_text,start_byte,end_byte,byte_size) VALUES($1,$2,$3,'assistant.delta',$4,$5,$6,$7,$8)",
    [
      row.conversation_id,
      sequence,
      occurredAt,
      command.runId,
      command.text,
      startByte,
      endByte,
      2048 + 6 * Buffer.byteLength(command.text),
    ],
  );
  await connection.query('UPDATE task_run_streams SET delivered_bytes=$2 WHERE run_id=$1', [
    command.runId,
    endByte,
  ]);
  // A progress write may resume after the deadline. Return the typed expiry
  // before attempting the checkpoint; the caller rolls back the whole delta.
  if (row.deadline_at.getTime() <= now().getTime()) return false;
  await checkpointTaskPartialOutput(connection, { ...command, startByte, endByte }, occurredAt);
  await reclaimConversationStream(connection, row.conversation_id, occurredAt);
  // Progress/retention may have waited after the initial claim check. The
  // caller must roll back this whole transaction when the final guard fails.
  return row.deadline_at.getTime() > now().getTime();
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
  const receipt = {
    eventId: randomUUID(),
    sequence: await allocate(connection, access.conversationId),
  };
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
  await connection.query(
    'INSERT INTO conversation_delivery_events(conversation_id,sequence,occurred_at,event_type,ledger_event_id,byte_size) VALUES($1,$2,$3,$4,$5,2048)',
    [
      access.conversationId,
      receipt.sequence,
      occurredAt,
      value.messageId ? 'message.changed' : 'conversation.invalidated',
      receipt.eventId,
    ],
  );
  await reclaimConversationStream(connection, access.conversationId, occurredAt);
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
      `SELECT t.*,v.configuration,v.version,r.deadline_at FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN bot_versions v ON v.id=t.bot_version_id AND v.bot_id=t.bot_id WHERE r.id=$1 AND r.claim_token=$2 AND r.status='running' AND t.status='running'`,
      [command.runId, command.claimToken],
    )
  ).rows[0];
  if (!row || row.deadline_at.getTime() <= now().getTime()) return undefined;
  if (!(await lockTaskAncestry(connection, row.id))) return undefined;
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
    data: command.attachmentId ? { attachmentId: command.attachmentId } : {},
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

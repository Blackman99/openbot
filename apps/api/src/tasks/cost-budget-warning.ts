import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { reclaimConversationStream } from '../conversations/stream-retention.js';
import { encodeConversationStreamEvent } from '../conversations/stream-protocol.js';
import {
  costBudgetWarningCrossings,
  type CostBudgetLayer,
  type CostBudgetWarningCrossing,
  type CostReservationDecision,
} from './cost-budget.js';

function warningBody(warning: CostBudgetWarningCrossing) {
  return warning.hard
    ? `Cost usage reached the ${warning.limit} ${warning.source} limit.`
    : `Cost usage reached 80% of the ${warning.limit} ${warning.source} limit.`;
}

export async function appendCostBudgetWarnings(
  connection: SqlConnection,
  input: {
    taskId: string;
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    now: Date;
  },
  warnings: Array<{ kind: CostBudgetLayer } & CostReservationDecision>,
) {
  for (const warning of costBudgetWarningCrossings(warnings))
    await appendCostBudgetWarning(connection, input, warning);
}

async function appendCostBudgetWarning(
  connection: SqlConnection,
  input: {
    taskId: string;
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    now: Date;
  },
  warning: CostBudgetWarningCrossing,
) {
  const idempotencyKey = `task-cost-warning:${input.taskId}:${warning.source}:cost`;
  const existing = (
    await connection.query(
      'SELECT id FROM conversation_events WHERE conversation_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
      [input.conversationId, input.executionUserId, idempotencyKey],
    )
  ).rows[0];
  if (existing) return;
  const sequence = Number(
    (
      await connection.query<{ last_sequence: string | number }>(
        'UPDATE conversations SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING last_sequence',
        [input.conversationId],
      )
    ).rows[0]!.last_sequence,
  );
  await connection.query(
    'INSERT INTO conversation_delivery_state(conversation_id,floor) VALUES($1,$2) ON CONFLICT(conversation_id) DO NOTHING',
    [input.conversationId, sequence - 1],
  );
  const eventId = randomUUID();
  const data = {
    taskId: input.taskId,
    dimension: warning.dimension,
    used: warning.used,
    limit: warning.limit,
    source: warning.source,
    soft: warning.soft,
    hard: warning.hard,
  };
  const body = warningBody(warning);
  encodeConversationStreamEvent(
    { workspaceId: input.workspaceId, conversationId: input.conversationId },
    sequence,
    input.now,
    { type: 'task.limit.warning', data: { ...data, body } },
  );
  const hash = createHash('sha256')
    .update(JSON.stringify({ type: 'task.limit.warning', ...data }))
    .digest('hex');
  await connection.query(
    `INSERT INTO conversation_events(
      id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,reason,idempotency_key,command_hash,membership_id,event_data
    ) VALUES($1,$2,$3,NULL,NULL,'task.limit.warning',$4,$5,$6,NULL,$7,$8,NULL,$9::jsonb)`,
    [
      eventId,
      input.conversationId,
      sequence,
      input.executionUserId,
      input.now,
      body,
      idempotencyKey,
      hash,
      JSON.stringify(data),
    ],
  );
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.limit.warning',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      input.executionUserId,
      input.now,
      JSON.stringify({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        eventId,
        sequence,
        ...data,
      }),
    ],
  );
  const execution = JSON.stringify({ ...data, body });
  await connection.query(
    "INSERT INTO conversation_delivery_events(conversation_id,sequence,occurred_at,event_type,ledger_event_id,byte_size) VALUES($1,$2,$3,'conversation.invalidated',$4,$5)",
    [input.conversationId, sequence, input.now, eventId, 2048 + 2 * Buffer.byteLength(execution)],
  );
  await reclaimConversationStream(connection, input.conversationId, input.now);
}

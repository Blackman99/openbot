import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import {
  appendWaitingApprovalRunState,
  appendWaitingInputRunState,
} from '../conversations/append-event.js';
import { reclaimConversationStream } from '../conversations/stream-retention.js';
import { encodeConversationStreamEvent } from '../conversations/stream-protocol.js';
import { reconcileRunTokenReservation } from './token-budget-store.js';
import { reconcileRunCostReservation } from './cost-budget-store.js';
import { lockTaskAncestry } from './tree.js';
import type {
  HumanInputSchema,
  RequestApprovalAction,
  RequestInputAction,
} from './human-request-action.js';

export type HumanHoldAction =
  ({ kind: 'input' } & RequestInputAction) | ({ kind: 'approval' } & RequestApprovalAction);

export interface HumanHoldClaim {
  runId: string;
  taskId: string;
  claimToken: string;
}

export async function holdTaskForHumanRequest(
  connection: SqlConnection,
  claim: HumanHoldClaim,
  action: HumanHoldAction,
  now: Date,
): Promise<boolean> {
  const parent = (
    await connection.query<{
      id: string;
      workspace_id: string;
      conversation_id: string;
      execution_user_id: string;
      status: string;
    }>('SELECT id,workspace_id,conversation_id,execution_user_id,status FROM tasks WHERE id=$1', [
      claim.taskId,
    ])
  ).rows[0];
  const run = (
    await connection.query<{
      id: string;
      status: string;
      claim_token: string | null;
    }>('SELECT id,status,claim_token FROM task_runs WHERE id=$1', [claim.runId])
  ).rows[0];
  if (
    !parent ||
    parent.status !== 'running' ||
    run?.status !== 'running' ||
    run.claim_token !== claim.claimToken
  )
    return false;
  if (!(await lockTaskAncestry(connection, parent.id))) return false;
  const status = action.kind === 'input' ? 'waiting_input' : 'waiting_approval';
  const eventId = await appendHumanRequestEvent(connection, {
    workspaceId: parent.workspace_id,
    conversationId: parent.conversation_id,
    executionUserId: parent.execution_user_id,
    taskId: parent.id,
    runId: run.id,
    action,
    now,
  });
  await connection.query(
    action.kind === 'input'
      ? `INSERT INTO task_human_requests(
          id,task_id,source_run_id,kind,prompt,response_schema,summary,event_id,created_at
        ) VALUES($1,$2,$3,'input',$4,$5::jsonb,NULL,$6,$7)`
      : `INSERT INTO task_human_requests(
          id,task_id,source_run_id,kind,prompt,response_schema,summary,event_id,created_at
        ) VALUES($1,$2,$3,'approval',NULL,NULL,$4,$5,$6)`,
    action.kind === 'input'
      ? [
          randomUUID(),
          parent.id,
          run.id,
          action.prompt,
          JSON.stringify(action.responseSchema),
          eventId,
          now,
        ]
      : [randomUUID(), parent.id, run.id, action.summary, eventId, now],
  );
  const parked = await connection.query<{ id: string }>(
    `UPDATE task_runs SET status=$2,finished_at=$3
     WHERE id=$1 AND status='running' AND claim_token=$4 RETURNING id`,
    [run.id, status, now, claim.claimToken],
  );
  if (!parked.rows.length) return false;
  await connection.query('UPDATE tasks SET status=$2 WHERE id=$1 AND status=$3', [
    parent.id,
    status,
    'running',
  ]);
  const group = (
    await connection.query<{ group_id: string | null }>(
      'SELECT group_id FROM conversations WHERE id=$1',
      [parent.conversation_id],
    )
  ).rows[0];
  const target = {
    runId: run.id,
    taskId: parent.id,
    workspaceId: parent.workspace_id,
    groupId: group?.group_id ?? null,
  };
  await reconcileRunTokenReservation(connection, target, { inputTokens: 0, outputTokens: 0 });
  await reconcileRunCostReservation(connection, target, 0);
  await connection.query(
    'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [
      randomUUID(),
      action.kind === 'input' ? 'task.waiting_input' : 'task.waiting_approval',
      parent.execution_user_id,
      now,
      JSON.stringify({
        workspaceId: parent.workspace_id,
        conversationId: parent.conversation_id,
        taskId: parent.id,
        runId: run.id,
      }),
    ],
  );
  if (action.kind === 'input') await appendWaitingInputRunState(connection, run.id, () => now);
  else await appendWaitingApprovalRunState(connection, run.id, () => now);
  return true;
}

async function appendHumanRequestEvent(
  connection: SqlConnection,
  input: {
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    taskId: string;
    runId: string;
    action: HumanHoldAction;
    now: Date;
  },
) {
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
  const type = input.action.kind === 'input' ? 'task.input.requested' : 'task.approval.requested';
  const data =
    input.action.kind === 'input'
      ? {
          taskId: input.taskId,
          prompt: input.action.prompt,
          responseSchema: input.action.responseSchema,
        }
      : { taskId: input.taskId, summary: input.action.summary };
  const body = input.action.kind === 'input' ? input.action.prompt : input.action.summary;
  encodeConversationStreamEvent(
    { workspaceId: input.workspaceId, conversationId: input.conversationId },
    sequence,
    input.now,
    input.action.kind === 'input'
      ? {
          type: 'task.input.requested',
          data: data as { taskId: string; prompt: string; responseSchema: HumanInputSchema },
        }
      : {
          type: 'task.approval.requested',
          data: { taskId: input.taskId, summary: input.action.summary },
        },
  );
  const hash = createHash('sha256')
    .update(JSON.stringify({ type, ...data }))
    .digest('hex');
  await connection.query(
    `INSERT INTO conversation_events(
      id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,reason,idempotency_key,command_hash,membership_id,event_data
    ) VALUES($1,$2,$3,NULL,NULL,$4,$5,$6,$7,NULL,$8,$9,NULL,$10::jsonb)`,
    [
      eventId,
      input.conversationId,
      sequence,
      type,
      input.executionUserId,
      input.now,
      body,
      `${type}:${input.taskId}:${input.runId}`,
      hash,
      JSON.stringify(data),
    ],
  );
  await connection.query(
    'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [
      randomUUID(),
      type,
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
  return eventId;
}

import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { appendFailedRunState } from '../conversations/append-event.js';
import { reclaimConversationStream } from '../conversations/stream-retention.js';
import { encodeConversationStreamEvent } from '../conversations/stream-protocol.js';
import { ConversationAccessError } from '../conversations/service.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { admitTaskTarget } from './admission.js';
import type { HandoffAction } from './handoff-action.js';
import {
  applyTaskExecutionLimits,
  holdTaskForBudget,
  loadEffectiveTaskLimits,
  measureTaskLimitUsage,
} from './execution-limit-enforcement.js';
import { writeNextAttempt } from './next-attempt.js';
import { persistTokenUsage } from './token-usage.js';
import { reconcileRunTokenReservation } from './token-budget-store.js';
import { lockTaskAncestry } from './tree.js';
import type { BotBinding } from '../bots/service.js';

export interface HandoffClaim {
  runId: string;
  taskId: string;
  claimToken: string;
}

export async function transferTaskLead(
  connection: SqlConnection,
  claim: HandoffClaim,
  action: HandoffAction,
  now: Date,
): Promise<boolean> {
  const parent = (
    await connection.query<{
      id: string;
      workspace_id: string;
      conversation_id: string;
      execution_user_id: string;
      bot_id: string;
      bot_version_id: string;
      group_grant_id: string | null;
      status: string;
    }>(
      `SELECT id,workspace_id,conversation_id,execution_user_id,bot_id,bot_version_id,group_grant_id,status
       FROM tasks WHERE id=$1`,
      [claim.taskId],
    )
  ).rows[0];
  const run = (
    await connection.query<{
      id: string;
      attempt: number;
      status: string;
      claim_token: string | null;
      connection_id: string | null;
      model_id: string | null;
      provider_scope_kind: 'personal' | 'workspace' | null;
      provider_scope_id: string | null;
    }>(
      `SELECT id,attempt,status,claim_token,connection_id,model_id,provider_scope_kind,provider_scope_id
       FROM task_runs WHERE id=$1`,
      [claim.runId],
    )
  ).rows[0];
  if (
    !parent ||
    !parent.group_grant_id ||
    parent.status !== 'running' ||
    run?.status !== 'running' ||
    run.claim_token !== claim.claimToken
  )
    return false;
  if (!(await lockTaskAncestry(connection, parent.id))) return false;
  if (action.grantId === parent.group_grant_id) return false;
  const access = {
    actorUserId: parent.execution_user_id,
    workspaceId: parent.workspace_id,
    conversationId: parent.conversation_id,
  };
  let target;
  try {
    target = await admitTaskTarget(connection, access, action.grantId, () => now);
  } catch (error) {
    if (error instanceof ConversationAccessError || error instanceof GroupBotAccessError)
      return false;
    throw error;
  }
  if (target.conversationId !== parent.conversation_id) return false;
  if (target.botId === parent.bot_id) return false;
  const limits = await loadEffectiveTaskLimits(connection, parent.id);
  const usage = await measureTaskLimitUsage(connection, parent.id, now);
  const handoffHard = Boolean(limits?.handoffs && usage.handoffs >= limits.handoffs.maxHandoffs);
  const turnHard = Boolean(limits?.turns && usage.turns >= limits.turns.maxTurns);
  if (handoffHard || turnHard) return false;
  const sourceName = await botName(connection, parent.bot_id, parent.bot_version_id);
  const targetName = target.configuration.name;
  const previousBinding = previousRunBinding(run);
  if (!previousBinding) return false;
  await failCurrentRun(connection, parent, run, now);
  const eventId = await appendHandoffEvent(connection, {
    workspaceId: parent.workspace_id,
    conversationId: parent.conversation_id,
    executionUserId: parent.execution_user_id,
    taskId: parent.id,
    reason: action.reason,
    source: { grantId: parent.group_grant_id, botId: parent.bot_id, botName: sourceName },
    target: { grantId: action.grantId, botId: target.botId, botName: targetName },
    now,
  });
  await connection.query(
    `INSERT INTO task_handoffs(
      source_run_id,task_id,source_grant_id,source_bot_id,target_grant_id,target_bot_id,
      target_bot_version_id,reason,event_id,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      run.id,
      parent.id,
      parent.group_grant_id,
      parent.bot_id,
      action.grantId,
      target.botId,
      target.versionId,
      action.reason,
      eventId,
      now,
    ],
  );
  await connection.query(
    'UPDATE tasks SET bot_id=$2,bot_version_id=$3,group_grant_id=$4 WHERE id=$1 AND status=$5',
    [parent.id, target.botId, target.versionId, action.grantId, 'failed'],
  );
  const written = await writeNextAttempt(connection, {
    taskId: parent.id,
    sourceRunId: run.id,
    workspaceId: parent.workspace_id,
    conversationId: parent.conversation_id,
    executionUserId: parent.execution_user_id,
    sourceAttempt: run.attempt,
    plan: {
      origin: 'handoff',
      reason: 'lead_handoff',
      binding: target.configuration.modelBinding,
      previousBinding,
      notBefore: now,
      delayMs: 0,
      jitterMs: 0,
      chainRootRunId: run.id,
      previousRunId: run.id,
      chainAttemptOrdinal: 1,
      chainLimitSnapshot: 4,
      modelAttemptOrdinal: 1,
    },
    now,
  });
  if (!written.scheduled) {
    if (written.reason === 'budget') {
      await holdTaskForBudget(connection, {
        taskId: parent.id,
        workspaceId: parent.workspace_id,
        conversationId: parent.conversation_id,
        executionUserId: parent.execution_user_id,
        now,
      });
      return true;
    }
    return false;
  }
  await applyTaskExecutionLimits(
    connection,
    {
      taskId: parent.id,
      workspaceId: parent.workspace_id,
      conversationId: parent.conversation_id,
      executionUserId: parent.execution_user_id,
      now,
    },
    { holdIfHard: false },
  );
  return true;
}

async function failCurrentRun(
  connection: SqlConnection,
  parent: {
    id: string;
    execution_user_id: string;
    workspace_id: string;
    conversation_id: string;
  },
  run: { id: string },
  now: Date,
) {
  const group = (
    await connection.query<{ group_id: string | null }>(
      'SELECT group_id FROM conversations WHERE id=$1',
      [parent.conversation_id],
    )
  ).rows[0];
  await connection.query(
    `UPDATE task_runs SET status='failed',finished_at=$2,error_code='handed_off',input_tokens=$3,output_tokens=$4,usage_estimated=$5
     WHERE id=$1 AND status='running'`,
    [run.id, now, ...persistTokenUsage(null)],
  );
  await reconcileRunTokenReservation(
    connection,
    {
      runId: run.id,
      taskId: parent.id,
      workspaceId: parent.workspace_id,
      groupId: group?.group_id ?? null,
    },
    { inputTokens: 0, outputTokens: 0 },
  );
  await connection.query("UPDATE tasks SET status='failed' WHERE id=$1 AND status='running'", [
    parent.id,
  ]);
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.failed',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      parent.execution_user_id,
      now,
      JSON.stringify({
        workspaceId: parent.workspace_id,
        conversationId: parent.conversation_id,
        taskId: parent.id,
        runId: run.id,
        error: 'handed_off',
      }),
    ],
  );
  await appendFailedRunState(connection, run.id, () => now);
}

async function appendHandoffEvent(
  connection: SqlConnection,
  input: {
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    taskId: string;
    reason: string;
    source: { grantId: string; botId: string; botName: string };
    target: { grantId: string; botId: string; botName: string };
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
  const data = {
    taskId: input.taskId,
    source: input.source,
    target: input.target,
  };
  const body = `Lead handed off from ${input.source.botName} to ${input.target.botName}: ${input.reason}`;
  encodeConversationStreamEvent(
    { workspaceId: input.workspaceId, conversationId: input.conversationId },
    sequence,
    input.now,
    { type: 'task.handoff', data: { ...data, reason: input.reason } },
  );
  const hash = createHash('sha256')
    .update(JSON.stringify({ type: 'task.handoff', ...data, reason: input.reason }))
    .digest('hex');
  await connection.query(
    `INSERT INTO conversation_events(
      id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,reason,idempotency_key,command_hash,membership_id,event_data
    ) VALUES($1,$2,$3,NULL,NULL,'task.handoff',$4,$5,$6,NULL,$7,$8,NULL,$9::jsonb)`,
    [
      eventId,
      input.conversationId,
      sequence,
      input.executionUserId,
      input.now,
      body,
      `task-handoff:${input.taskId}:${data.source.grantId}:${data.target.grantId}`,
      hash,
      JSON.stringify({ ...data, reason: input.reason }),
    ],
  );
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.handoff',$2,$3,$4::jsonb)",
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
        reason: input.reason,
      }),
    ],
  );
  const execution = JSON.stringify({ ...data, reason: input.reason, body });
  await connection.query(
    "INSERT INTO conversation_delivery_events(conversation_id,sequence,occurred_at,event_type,ledger_event_id,byte_size) VALUES($1,$2,$3,'conversation.invalidated',$4,$5)",
    [input.conversationId, sequence, input.now, eventId, 2048 + 2 * Buffer.byteLength(execution)],
  );
  await reclaimConversationStream(connection, input.conversationId, input.now);
  return eventId;
}

async function botName(connection: SqlConnection, botId: string, versionId: string) {
  const row = (
    await connection.query<{ name: string }>(
      `SELECT configuration->>'name' AS name FROM bot_versions WHERE bot_id=$1 AND id=$2`,
      [botId, versionId],
    )
  ).rows[0];
  return row?.name || 'Lead';
}

function previousRunBinding(run: {
  connection_id: string | null;
  model_id: string | null;
  provider_scope_kind: 'personal' | 'workspace' | null;
  provider_scope_id: string | null;
}): BotBinding | undefined {
  if (!run.connection_id || !run.model_id || !run.provider_scope_kind || !run.provider_scope_id)
    return undefined;
  return {
    scope: { kind: run.provider_scope_kind, id: run.provider_scope_id },
    connectionId: run.connection_id,
    modelId: run.model_id,
  };
}

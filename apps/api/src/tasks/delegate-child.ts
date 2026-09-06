import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { appendQueuedRunState, appendWaitingChildRunState } from '../conversations/append-event.js';
import { ConversationAccessError } from '../conversations/service.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { admitTaskTarget } from './admission.js';
import { attributedChildResult, inheritChildLimits } from './delegate.js';
import type { DelegateAction } from './delegate-action.js';
import { persistTaskLimitSnapshot, taskPolicyFromBotLimits } from './execution-limits.js';
import {
  loadTaskLimitSnapshot,
  remainingSnapshotDurationMs,
} from './execution-limit-enforcement.js';
import { writeNextAttempt } from './next-attempt.js';
import { taskSubmissionHash } from './submission-admission.js';
import { lockTaskAncestry } from './tree.js';

export interface DelegateClaim {
  runId: string;
  taskId: string;
  claimToken: string;
}

export async function createDelegatedChild(
  connection: SqlConnection,
  claim: DelegateClaim,
  action: DelegateAction,
  actionId: string,
  now: Date,
): Promise<{ childTaskId: string } | { denied: true }> {
  const parent = (
    await connection.query<{
      id: string;
      workspace_id: string;
      conversation_id: string;
      execution_user_id: string;
      group_grant_id: string | null;
      root_task_id: string;
      parent_task_id: string | null;
      depth: number;
      status: string;
    }>(
      'SELECT id,workspace_id,conversation_id,execution_user_id,group_grant_id,root_task_id,parent_task_id,depth,status FROM tasks WHERE id=$1',
      [claim.taskId],
    )
  ).rows[0];
  if (!parent || !parent.group_grant_id || parent.status !== 'running') return { denied: true };
  if (!(await lockTaskAncestry(connection, parent.id))) return { denied: true };
  const existing = (
    await connection.query<{ child_task_id: string }>(
      'SELECT child_task_id FROM task_delegations WHERE parent_run_id=$1',
      [claim.runId],
    )
  ).rows[0];
  if (existing) return { childTaskId: existing.child_task_id };
  const unfinished = (
    await connection.query(
      `SELECT id FROM tasks WHERE parent_task_id=$1 AND status IN ('queued','running','waiting_child')`,
      [parent.id],
    )
  ).rows[0];
  if (unfinished) return { denied: true };
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
      return { denied: true };
    throw error;
  }
  if (target.conversationId !== parent.conversation_id) return { denied: true };
  const snapshot = await loadTaskLimitSnapshot(connection, parent.id);
  if (!snapshot?.delegationDepth) return { denied: true };
  if (parent.depth + 1 > snapshot.delegationDepth.maxDelegationDepth) return { denied: true };
  const remainingMs = await remainingSnapshotDurationMs(connection, parent.id, now);
  const childLimits = inheritChildLimits({
    parent: snapshot,
    ...(remainingMs !== undefined ? { parentRemainingDurationMs: remainingMs } : {}),
    bot: taskPolicyFromBotLimits(target.configuration.limits),
  });
  if (!childLimits) return { denied: true };
  const conversation = target.conversation;
  const trigger = await conversation.appendTaskTrigger({
    idempotencyKey: `delegate:${claim.runId}:${actionId}`,
    body: action.body,
    groupGrantId: action.grantId,
  });
  const childId = randomUUID(),
    runId = randomUUID(),
    hash = taskSubmissionHash(action.body, action.grantId);
  const policy = {
    maxDurationSeconds: childLimits.duration!.maxDurationMs / 1000,
    maxTurns: childLimits.turns!.maxTurns,
    maxDelegationDepth: childLimits.delegationDepth!.maxDelegationDepth,
    ...(childLimits.handoffs ? { maxHandoffs: childLimits.handoffs.maxHandoffs } : {}),
  };
  await connection.query(
    `INSERT INTO tasks(
      id,workspace_id,conversation_id,bot_id,bot_version_id,execution_user_id,trigger_event_id,command_hash,
      status,created_at,group_grant_id,root_task_id,parent_task_id,depth,execution_policy
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      childId,
      parent.workspace_id,
      parent.conversation_id,
      target.botId,
      target.versionId,
      parent.execution_user_id,
      trigger.receipt.eventId,
      hash,
      now,
      action.grantId,
      parent.root_task_id,
      parent.id,
      parent.depth + 1,
      JSON.stringify(policy),
    ],
  );
  await connection.query(
    "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,1,'queued',$3)",
    [runId, childId, now],
  );
  await persistTaskLimitSnapshot(connection, childId, childLimits, now);
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.queued',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      parent.execution_user_id,
      now,
      JSON.stringify({
        workspaceId: parent.workspace_id,
        conversationId: parent.conversation_id,
        taskId: childId,
        runId,
        botId: target.botId,
        botVersionId: target.versionId,
        triggerEventId: trigger.receipt.eventId,
        attempt: 1,
        parentTaskId: parent.id,
        parentRunId: claim.runId,
        origin: 'delegate',
      }),
    ],
  );
  await appendQueuedRunState(connection, runId, () => now);
  await connection.query(
    'INSERT INTO task_delegations(parent_run_id,parent_task_id,child_task_id,action_id,created_at) VALUES($1,$2,$3,$4,$5)',
    [claim.runId, parent.id, childId, actionId, now],
  );
  return { childTaskId: childId };
}

export async function parkParentForChild(
  connection: SqlConnection,
  claim: DelegateClaim,
  now: Date,
): Promise<boolean> {
  const parked = await connection.query<{ id: string }>(
    `UPDATE task_runs SET status='waiting_child',finished_at=$2
     WHERE id=$1 AND status='running' AND claim_token=$3 RETURNING id`,
    [claim.runId, now, claim.claimToken],
  );
  if (!parked.rows.length) return false;
  await connection.query(
    "UPDATE tasks SET status='waiting_child' WHERE id=$1 AND status='running'",
    [claim.taskId],
  );
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.waiting_child',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      (
        await connection.query<{ execution_user_id: string }>(
          'SELECT execution_user_id FROM tasks WHERE id=$1',
          [claim.taskId],
        )
      ).rows[0]!.execution_user_id,
      now,
      JSON.stringify({
        taskId: claim.taskId,
        runId: claim.runId,
      }),
    ],
  );
  await appendWaitingChildRunState(connection, claim.runId, () => now);
  return true;
}

export async function resumeParentAfterChild(
  connection: SqlConnection,
  childTaskId: string,
  now: Date,
): Promise<boolean> {
  const delegation = (
    await connection.query<{
      parent_run_id: string;
      parent_task_id: string;
    }>('SELECT parent_run_id,parent_task_id FROM task_delegations WHERE child_task_id=$1', [
      childTaskId,
    ])
  ).rows[0];
  if (!delegation) return false;
  const parent = (
    await connection.query<{
      id: string;
      workspace_id: string;
      conversation_id: string;
      execution_user_id: string;
      bot_id: string;
      bot_version_id: string;
      status: string;
    }>(
      'SELECT id,workspace_id,conversation_id,execution_user_id,bot_id,bot_version_id,status FROM tasks WHERE id=$1',
      [delegation.parent_task_id],
    )
  ).rows[0];
  const parentRun = (
    await connection.query<{
      id: string;
      attempt: number;
      status: string;
      connection_id: string | null;
      model_id: string | null;
    }>('SELECT id,attempt,status,connection_id,model_id FROM task_runs WHERE id=$1', [
      delegation.parent_run_id,
    ])
  ).rows[0];
  if (!parent || parent.status !== 'waiting_child' || parentRun?.status !== 'waiting_child')
    return false;
  const child = (
    await connection.query<{
      status: string;
      bot_name: string;
    }>(
      `SELECT t.status,v.configuration->>'name' AS bot_name
       FROM tasks t JOIN bot_versions v ON v.id=t.bot_version_id AND v.bot_id=t.bot_id
       WHERE t.id=$1`,
      [childTaskId],
    )
  ).rows[0];
  if (!child || !['completed', 'failed', 'cancelled'].includes(child.status)) return false;
  const childRun = (
    await connection.query<{
      error_code: string | null;
      body: string | null;
    }>(
      `SELECT r.error_code,e.body FROM task_runs r
       LEFT JOIN conversation_events e ON e.id=r.output_event_id
       WHERE r.task_id=$1 ORDER BY r.attempt DESC LIMIT 1`,
      [childTaskId],
    )
  ).rows[0];
  const outcome =
    child.status === 'completed'
      ? { status: 'completed' as const, body: childRun?.body?.trim() || 'Child finished.' }
      : child.status === 'failed'
        ? { status: 'failed' as const, error: childRun?.error_code || 'provider_failed' }
        : { status: 'cancelled' as const };
  const attributed = attributedChildResult({
    childTaskId,
    botName: child.bot_name,
    outcome,
  });
  const target = await admitTaskTarget(
    connection,
    {
      actorUserId: parent.execution_user_id,
      workspaceId: parent.workspace_id,
      conversationId: parent.conversation_id,
    },
    (
      await connection.query<{ group_grant_id: string | null }>(
        'SELECT group_grant_id FROM tasks WHERE id=$1',
        [parent.id],
      )
    ).rows[0]!.group_grant_id,
    () => now,
    parent.bot_version_id,
  );
  const binding = target.configuration.modelBinding;
  const scheduled = await writeNextAttempt(connection, {
    taskId: parent.id,
    sourceRunId: parentRun.id,
    workspaceId: parent.workspace_id,
    conversationId: parent.conversation_id,
    executionUserId: parent.execution_user_id,
    sourceAttempt: parentRun.attempt,
    plan: {
      origin: 'child_result',
      reason: 'child_terminated',
      binding,
      previousBinding: binding,
      notBefore: now,
      delayMs: 0,
      jitterMs: 0,
      chainRootRunId: parentRun.id,
      previousRunId: parentRun.id,
      chainAttemptOrdinal: parentRun.attempt + 1,
      chainLimitSnapshot: 4,
      modelAttemptOrdinal: 1,
    },
    now,
    attributedResult: attributed,
    childTaskId,
  });
  return scheduled.scheduled;
}

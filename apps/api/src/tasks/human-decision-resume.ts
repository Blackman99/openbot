import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { reclaimConversationStream } from '../conversations/stream-retention.js';
import { encodeConversationStreamEvent } from '../conversations/stream-protocol.js';
import { type ConversationAccess } from '../conversations/service.js';
import { admitTaskTarget } from './admission.js';
import { TaskAccessError, TaskConflictError, TaskInputError } from './errors.js';
import {
  parseHumanApprovalDecision,
  parseHumanInputDecision,
  type HumanApprovalDecision,
  type HumanInputDecision,
} from './human-decision.js';
import { parseHumanInputSchema } from './human-request-action.js';
import { loadAttemptChain, writeNextAttempt } from './next-attempt.js';
import { effectiveRetryPolicy } from './retry-schedule.js';
import type { TaskStatus } from './service.js';
import { lockTaskAncestry } from './tree.js';
import type { BotBinding } from '../bots/service.js';

export interface HumanDecisionReceipt {
  requestId: string;
  runId: string;
  attempt: number;
  decidedAt: Date;
}

type OpenRequest = {
  id: string;
  kind: 'input' | 'approval';
  prompt: string | null;
  response_schema: unknown;
  summary: string | null;
  source_run_id: string;
  resolved_at: Date | null;
};

type SelectedTask = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  execution_user_id: string;
  bot_version_id: string;
  group_grant_id: string | null;
  status: TaskStatus;
};

type CurrentRun = {
  id: string;
  attempt: number;
  status: TaskStatus;
  connection_id: string | null;
  model_id: string | null;
  provider_scope_kind: 'personal' | 'workspace' | null;
  provider_scope_id: string | null;
};

type StoredDecision = {
  request_id: string;
  actor_user_id: string;
  idempotency_key: string;
  decision: 'input' | 'approve' | 'reject';
  values: Record<string, string | number | boolean> | null;
  created_at: Date;
};

export async function decideHumanRequest(
  connection: SqlConnection,
  access: ConversationAccess,
  taskId: string,
  input: unknown,
  now: () => Date,
): Promise<HumanDecisionReceipt> {
  await ConversationTransaction.lock(connection, access, now, 'inspect');
  const selected = (
    await connection.query<SelectedTask>(
      `SELECT id,workspace_id,conversation_id,execution_user_id,bot_version_id,group_grant_id,status
       FROM tasks WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3`,
      [taskId, access.workspaceId, access.conversationId],
    )
  ).rows[0];
  if (!selected) throw new TaskAccessError();
  const request = (
    await connection.query<OpenRequest>(
      `SELECT id,kind,prompt,response_schema,summary,source_run_id,resolved_at
       FROM task_human_requests WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [taskId],
    )
  ).rows[0];
  if (!request) throw new TaskAccessError();
  const schema =
    request.kind === 'input' ? parseHumanInputSchema(request.response_schema) : undefined;
  if (request.kind === 'input' && !schema) throw new TaskInputError();
  const parsed =
    request.kind === 'input'
      ? parseHumanInputDecision(schema!, input)
      : parseHumanApprovalDecision(input);
  const prior = (
    await connection.query<StoredDecision>(
      'SELECT request_id,actor_user_id,idempotency_key,decision,values,created_at FROM task_human_decisions WHERE request_id=$1',
      [request.id],
    )
  ).rows[0];
  if (prior) {
    if (!sameDecision(prior, access.actorUserId, parsed))
      throw new TaskConflictError('idempotency_conflict');
    const successor = (
      await connection.query<{ id: string; attempt: number }>(
        'SELECT id,attempt FROM task_runs WHERE task_id=$1 AND attempt>(SELECT attempt FROM task_runs WHERE id=$2) ORDER BY attempt LIMIT 1',
        [taskId, request.source_run_id],
      )
    ).rows[0];
    if (!successor) throw new TaskConflictError('task_human_decision_state_conflict');
    return {
      requestId: request.id,
      runId: successor.id,
      attempt: successor.attempt,
      decidedAt: prior.created_at,
    };
  }
  if (
    selected.status !== (request.kind === 'input' ? 'waiting_input' : 'waiting_approval') ||
    request.resolved_at
  )
    throw new TaskConflictError('task_human_decision_state_conflict');
  if (!(await lockTaskAncestry(connection, taskId, { allowPausedTarget: true })))
    throw new TaskConflictError('task_human_decision_state_conflict');
  const latest = (
    await connection.query<CurrentRun>(
      `SELECT id,attempt,status,connection_id,model_id,provider_scope_kind,provider_scope_id
       FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE`,
      [taskId],
    )
  ).rows[0];
  if (
    !latest ||
    latest.id !== request.source_run_id ||
    latest.status !== selected.status ||
    (latest.status !== 'waiting_input' && latest.status !== 'waiting_approval')
  )
    throw new TaskConflictError('task_human_decision_state_conflict');
  const occurredAt = now();
  const decision = parsedDecision(parsed);
  const eventId = await appendHumanDecisionEvent(connection, {
    workspaceId: selected.workspace_id,
    conversationId: selected.conversation_id,
    executionUserId: selected.execution_user_id,
    taskId,
    requestId: request.id,
    kind: request.kind,
    decision: decision.kind,
    summary: request.summary,
    now: occurredAt,
  });
  await connection.query(
    `INSERT INTO task_human_decisions(
      request_id,actor_user_id,idempotency_key,decision,values,event_id,created_at
    ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [
      request.id,
      access.actorUserId,
      parsed.idempotencyKey,
      decision.kind,
      decision.values ? JSON.stringify(decision.values) : null,
      eventId,
      occurredAt,
    ],
  );
  const resolved = await connection.query<{ id: string }>(
    'UPDATE task_human_requests SET resolved_at=$2 WHERE id=$1 AND resolved_at IS NULL RETURNING id',
    [request.id, occurredAt],
  );
  if (!resolved.rows.length) throw new TaskConflictError('task_human_decision_state_conflict');
  const executionAccess = {
    actorUserId: selected.execution_user_id,
    workspaceId: selected.workspace_id,
    conversationId: selected.conversation_id,
  };
  const target = await admitTaskTarget(
    connection,
    executionAccess,
    selected.group_grant_id,
    now,
    selected.bot_version_id,
  );
  const previousBinding = previousRunBinding(latest) ?? target.configuration.modelBinding;
  const chain = await loadAttemptChain(connection, taskId, latest.id);
  const policy = effectiveRetryPolicy(target.configuration.retryPolicy);
  const written = await writeNextAttempt(connection, {
    taskId,
    sourceRunId: latest.id,
    workspaceId: selected.workspace_id,
    conversationId: selected.conversation_id,
    executionUserId: selected.execution_user_id,
    sourceAttempt: latest.attempt,
    plan: {
      origin: 'human_decision',
      reason: 'human_decision',
      binding: target.configuration.modelBinding,
      previousBinding,
      notBefore: occurredAt,
      delayMs: 0,
      jitterMs: 0,
      chainRootRunId: chain.rootRunId,
      previousRunId: latest.id,
      chainAttemptOrdinal: chain.attempts.length + 1,
      chainLimitSnapshot: policy.maxRunsPerChain,
      modelAttemptOrdinal: 1,
    },
    now: occurredAt,
    attributedResult: attributedResult(request, parsed),
  });
  if (!written.scheduled) throw new TaskConflictError('task_human_decision_state_conflict');
  const next = (
    await connection.query<{ attempt: number }>('SELECT attempt FROM task_runs WHERE id=$1', [
      written.runId,
    ])
  ).rows[0]!;
  return {
    requestId: request.id,
    runId: written.runId,
    attempt: next.attempt,
    decidedAt: occurredAt,
  };
}

function parsedDecision(parsed: HumanInputDecision | HumanApprovalDecision): {
  kind: 'input' | 'approve' | 'reject';
  values?: Record<string, string | number | boolean>;
} {
  if ('values' in parsed) return { kind: 'input', values: parsed.values };
  return { kind: parsed.decision };
}

function sameDecision(
  prior: StoredDecision,
  actorUserId: string,
  parsed: HumanInputDecision | HumanApprovalDecision,
): boolean {
  if (prior.actor_user_id !== actorUserId || prior.idempotency_key !== parsed.idempotencyKey)
    return false;
  if ('values' in parsed)
    return (
      prior.decision === 'input' && JSON.stringify(prior.values) === JSON.stringify(parsed.values)
    );
  return prior.decision === parsed.decision && prior.values === null;
}

function attributedResult(
  request: OpenRequest,
  parsed: HumanInputDecision | HumanApprovalDecision,
): string {
  if ('values' in parsed) {
    return `Human input:\n${Object.entries(parsed.values)
      .map(([name, value]) => `${name}: ${String(value)}`)
      .join('\n')}`;
  }
  const summary = request.summary ?? '';
  return parsed.decision === 'approve'
    ? `Human approved: ${summary}`
    : `Human rejected: ${summary}`;
}

function previousRunBinding(run: CurrentRun): BotBinding | undefined {
  if (!run.connection_id || !run.model_id || !run.provider_scope_kind || !run.provider_scope_id)
    return undefined;
  return {
    scope: { kind: run.provider_scope_kind, id: run.provider_scope_id },
    connectionId: run.connection_id,
    modelId: run.model_id,
  };
}

async function appendHumanDecisionEvent(
  connection: SqlConnection,
  input: {
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    taskId: string;
    requestId: string;
    kind: 'input' | 'approval';
    decision: 'input' | 'approve' | 'reject';
    summary: string | null;
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
  const data = { taskId: input.taskId, kind: input.kind, decision: input.decision };
  const body =
    input.decision === 'input'
      ? 'Human submitted input'
      : input.decision === 'approve'
        ? `Human approved: ${input.summary ?? ''}`
        : `Human rejected: ${input.summary ?? ''}`;
  encodeConversationStreamEvent(
    { workspaceId: input.workspaceId, conversationId: input.conversationId },
    sequence,
    input.now,
    { type: 'task.human.decided', data },
  );
  const hash = createHash('sha256')
    .update(JSON.stringify({ type: 'task.human.decided', ...data }))
    .digest('hex');
  await connection.query(
    `INSERT INTO conversation_events(
      id,conversation_id,sequence,message_id,message_version,event_type,actor_user_id,occurred_at,body,reason,idempotency_key,command_hash,membership_id,event_data
    ) VALUES($1,$2,$3,NULL,NULL,'task.human.decided',$4,$5,$6,NULL,$7,$8,NULL,$9::jsonb)`,
    [
      eventId,
      input.conversationId,
      sequence,
      input.executionUserId,
      input.now,
      body,
      `task.human.decided:${input.requestId}`,
      hash,
      JSON.stringify(data),
    ],
  );
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.human.decided',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      input.executionUserId,
      input.now,
      JSON.stringify({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        eventId,
        sequence,
        requestId: input.requestId,
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

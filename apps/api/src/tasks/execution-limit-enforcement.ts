import { createHash, randomUUID } from 'node:crypto';
import { publishWorkspaceTaskEvent } from '../events/publish.js';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { reclaimConversationStream } from '../conversations/stream-retention.js';
import { encodeConversationStreamEvent } from '../conversations/stream-protocol.js';
import type { ExecutionLimitLayer, ResolvedExecutionLimits } from './execution-limits.js';

// Soft warnings fire at four fifths of the snapshotted hard cap. Duration is
// active-Run milliseconds after lock wait. Turns are successful completed
// Runs. Depth is parent edges from the root. Handoffs are committed Lead
// transfers. Workspace and Group caps remain per-root snapshots.

export const EXECUTION_LIMIT_SOFT_NUMERATOR = 4;
export const EXECUTION_LIMIT_SOFT_DENOMINATOR = 5;
export const EXECUTION_LIMIT_DIMENSIONS = [
  'duration',
  'turns',
  'delegationDepth',
  'handoffs',
] as const;
export type ExecutionLimitDimension = (typeof EXECUTION_LIMIT_DIMENSIONS)[number];

export interface ExecutionLimitUsage {
  durationMs: number;
  turns: number;
  delegationDepth: number;
  handoffs: number;
}

export interface ExecutionLimitCrossing {
  dimension: ExecutionLimitDimension;
  used: number;
  limit: number;
  source: ExecutionLimitLayer;
  soft: boolean;
  hard: boolean;
}

function crossedSoft(used: number, limit: number) {
  return (
    limit > 0 && used * EXECUTION_LIMIT_SOFT_DENOMINATOR >= limit * EXECUTION_LIMIT_SOFT_NUMERATOR
  );
}

function crossing(
  dimension: ExecutionLimitDimension,
  used: number,
  limit: number,
  source: ExecutionLimitLayer,
  hard: boolean,
): ExecutionLimitCrossing | undefined {
  const soft = crossedSoft(used, limit);
  if (!soft && !hard) return undefined;
  return { dimension, used, limit, source, soft, hard };
}

export function evaluateExecutionLimitUsage(
  limits: ResolvedExecutionLimits,
  usage: ExecutionLimitUsage,
): ExecutionLimitCrossing[] {
  return [
    limits.duration
      ? crossing(
          'duration',
          usage.durationMs,
          limits.duration.maxDurationMs,
          limits.duration.source,
          usage.durationMs >= limits.duration.maxDurationMs,
        )
      : undefined,
    limits.turns
      ? crossing(
          'turns',
          usage.turns,
          limits.turns.maxTurns,
          limits.turns.source,
          usage.turns >= limits.turns.maxTurns,
        )
      : undefined,
    limits.delegationDepth
      ? crossing(
          'delegationDepth',
          usage.delegationDepth,
          limits.delegationDepth.maxDelegationDepth,
          limits.delegationDepth.source,
          usage.delegationDepth > limits.delegationDepth.maxDelegationDepth,
        )
      : undefined,
    limits.handoffs
      ? crossing(
          'handoffs',
          usage.handoffs,
          limits.handoffs.maxHandoffs,
          limits.handoffs.source,
          usage.handoffs >= limits.handoffs.maxHandoffs,
        )
      : undefined,
  ].filter((item): item is ExecutionLimitCrossing => item !== undefined);
}

export function hasHardExecutionLimit(crossings: readonly ExecutionLimitCrossing[]) {
  return crossings.some((item) => item.hard);
}

export function remainingDurationMs(maxDurationMs: number, usedMs: number) {
  return Math.max(0, maxDurationMs - usedMs);
}

export async function loadEffectiveTaskLimits(
  connection: SqlConnection,
  taskId: string,
): Promise<ResolvedExecutionLimits | undefined> {
  const snapshot = await loadTaskLimitSnapshot(connection, taskId);
  if (!snapshot) return undefined;
  const grants = (
    await connection.query<{
      dimension: ExecutionLimitDimension;
      granted_limit: string | number;
    }>(
      'SELECT dimension,granted_limit FROM task_execution_limit_grants WHERE task_id=$1 ORDER BY created_at,id',
      [taskId],
    )
  ).rows;
  const effective = { ...snapshot };
  for (const grant of grants) {
    const granted = Number(grant.granted_limit);
    if (grant.dimension === 'duration' && effective.duration)
      effective.duration = { ...effective.duration, maxDurationMs: granted };
    if (grant.dimension === 'turns' && effective.turns)
      effective.turns = { ...effective.turns, maxTurns: granted };
    if (grant.dimension === 'delegationDepth' && effective.delegationDepth)
      effective.delegationDepth = {
        ...effective.delegationDepth,
        maxDelegationDepth: granted,
      };
    if (grant.dimension === 'handoffs')
      effective.handoffs = {
        maxHandoffs: granted,
        source: effective.handoffs?.source ?? 'run',
      };
  }
  return effective;
}

export async function remainingSnapshotDurationMs(
  connection: SqlConnection,
  taskId: string,
  now: Date,
): Promise<number | undefined> {
  const limits = await loadEffectiveTaskLimits(connection, taskId);
  if (!limits?.duration) return undefined;
  return remainingDurationMs(
    limits.duration.maxDurationMs,
    (await measureTaskLimitUsage(connection, taskId, now)).durationMs,
  );
}

export async function loadTaskLimitSnapshot(
  connection: SqlConnection,
  taskId: string,
): Promise<ResolvedExecutionLimits | undefined> {
  const row = (
    await connection.query<{
      max_duration_ms: string | number;
      duration_source: ExecutionLimitLayer;
      max_turns: number;
      turns_source: ExecutionLimitLayer;
      max_delegation_depth: number;
      delegation_depth_source: ExecutionLimitLayer;
      max_handoffs: number | null;
      handoffs_source: ExecutionLimitLayer | null;
    }>(
      `SELECT max_duration_ms,duration_source,max_turns,turns_source,max_delegation_depth,delegation_depth_source,max_handoffs,handoffs_source
       FROM task_execution_limit_snapshots WHERE task_id=$1`,
      [taskId],
    )
  ).rows[0];
  if (!row) return undefined;
  return {
    duration: { maxDurationMs: Number(row.max_duration_ms), source: row.duration_source },
    turns: { maxTurns: row.max_turns, source: row.turns_source },
    delegationDepth: {
      maxDelegationDepth: row.max_delegation_depth,
      source: row.delegation_depth_source,
    },
    ...(row.max_handoffs !== null && row.handoffs_source
      ? { handoffs: { maxHandoffs: row.max_handoffs, source: row.handoffs_source } }
      : {}),
  };
}

export async function measureTaskLimitUsage(
  connection: SqlConnection,
  taskId: string,
  now: Date,
): Promise<ExecutionLimitUsage> {
  const runs = (
    await connection.query<{
      status: string;
      started_at: Date | null;
      finished_at: Date | null;
    }>('SELECT status,started_at,finished_at FROM task_runs WHERE task_id=$1', [taskId])
  ).rows;
  let durationMs = 0,
    turns = 0;
  for (const run of runs) {
    if (run.status === 'completed') turns += 1;
    if (!run.started_at) continue;
    const end = run.finished_at ?? now;
    durationMs += Math.max(0, end.getTime() - run.started_at.getTime());
  }
  const task = (
    await connection.query<{ depth: number }>('SELECT depth FROM tasks WHERE id=$1', [taskId])
  ).rows[0];
  return {
    durationMs,
    turns,
    delegationDepth: task?.depth ?? 0,
    handoffs: Number(
      (
        await connection.query<{ n: string | number }>(
          'SELECT count(*)::int AS n FROM task_handoffs WHERE task_id=$1',
          [taskId],
        )
      ).rows[0]?.n ?? 0,
    ),
  };
}

export async function applyTaskExecutionLimits(
  connection: SqlConnection,
  input: {
    taskId: string;
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    now: Date;
  },
  options: { holdIfHard: boolean },
): Promise<{ hard: boolean }> {
  const limits = await loadEffectiveTaskLimits(connection, input.taskId);
  if (!limits) return { hard: false };
  const crossings = evaluateExecutionLimitUsage(
    limits,
    await measureTaskLimitUsage(connection, input.taskId, input.now),
  );
  for (const warning of crossings.filter((item) => item.soft))
    await appendExecutionLimitWarning(connection, input, warning);
  const hard = hasHardExecutionLimit(crossings);
  if (hard && options.holdIfHard) await holdTaskForBudget(connection, input);
  return { hard };
}

export async function holdTaskForBudget(
  connection: SqlConnection,
  input: {
    taskId: string;
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    now: Date;
  },
) {
  const held = await connection.query<{ id: string }>(
    "UPDATE tasks SET status='waiting_budget' WHERE id=$1 AND status IN ('queued','failed','paused') RETURNING id",
    [input.taskId],
  );
  if (!held.rows.length) return;
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.waiting_budget',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      input.executionUserId,
      input.now,
      JSON.stringify({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        taskId: input.taskId,
      }),
    ],
  );
  const group = (
    await connection.query<{ group_id: string | null }>(
      'SELECT group_id FROM conversations WHERE id=$1',
      [input.conversationId],
    )
  ).rows[0];
  await publishWorkspaceTaskEvent(connection, {
    workspaceId: input.workspaceId,
    groupId: group?.group_id ?? null,
    type: 'task.budget_exhausted',
    taskId: input.taskId,
    status: 'waiting_budget',
    occurredAt: input.now,
  });
}

async function appendExecutionLimitWarning(
  connection: SqlConnection,
  input: {
    taskId: string;
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    now: Date;
  },
  warning: ExecutionLimitCrossing,
) {
  const existing = (
    await connection.query(
      'SELECT dimension FROM task_execution_limit_warnings WHERE task_id=$1 AND dimension=$2',
      [input.taskId, warning.dimension],
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
      `task-limit-warning:${input.taskId}:${warning.dimension}`,
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
  await connection.query(
    `INSERT INTO task_execution_limit_warnings(
      task_id,dimension,used,limit_value,source,event_id,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.taskId,
      warning.dimension,
      warning.used,
      warning.limit,
      warning.source,
      eventId,
      input.now,
    ],
  );
  await reclaimConversationStream(connection, input.conversationId, input.now);
}

function warningBody(warning: ExecutionLimitCrossing) {
  const unit =
    warning.dimension === 'duration'
      ? 'ms'
      : warning.dimension === 'turns'
        ? ' turns'
        : warning.dimension === 'handoffs'
          ? ' handoffs'
          : ' depth';
  const label =
    warning.dimension === 'duration'
      ? 'Duration'
      : warning.dimension === 'turns'
        ? 'Turn'
        : warning.dimension === 'handoffs'
          ? 'Handoff'
          : 'Delegation-depth';
  return warning.hard
    ? `${label} usage reached the ${warning.limit}${unit} ${warning.source} limit.`
    : `${label} usage reached 80% of the ${warning.limit}${unit} ${warning.source} limit.`;
}

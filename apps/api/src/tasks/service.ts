import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { BotModelError, type BotConfiguration } from '../bots/service.js';
import { ProviderError } from '../providers/url-policy.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { admitTaskTarget } from './admission.js';
import { admitTaskSubmission, taskSubmissionHash } from './submission-admission.js';
import { GroupAccessError } from '../groups/service.js';
import type { RoutingDecision, RoutingSummary } from '../routing/matcher.js';
import { appendQueuedRunState } from '../conversations/append-event.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { messageCursor, encodeMessageCursor } from '../conversations/cursor.js';
import {
  conversationUuid,
  ConversationAccessError,
  ConversationConflictError,
  type ConversationAccess,
  messageRead,
} from '../conversations/service.js';
import type { ProviderProtocol } from '../providers/model-events.js';
import { admitUsableModel } from '../providers/postgres-model-admission.js';
import type { TaskFailure, Usage } from './queue.js';
import { cancelTask, cancellationCommand } from './cancellation.js';
import { pauseTask, pauseCommand } from './pause.js';
import { resumeTask, resumeCommand } from './resume.js';
import { TaskInputError, TaskAccessError, TaskConflictError } from './errors.js';
import { encodeRunHistoryCursor, runHistoryCursor, type RunHistoryCursor } from './run-history.js';
import type { TaskPartialOutput } from './partial-output.js';
import { lockTaskAncestry } from './tree.js';
import { loadRunContinuations, type RunContinuation } from './continuation.js';

export { TaskInputError, TaskAccessError, TaskConflictError } from './errors.js';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
export interface TaskView {
  id: string;
  conversationId: string;
  status: TaskStatus;
  createdAt: Date;
  bot: { id: string; name: string; versionId: string; versionNumber: number };
  executionUser: { id: string; displayName: string };
  groupGrantId: string | null;
  routing?: RoutingSummary;
  trigger: { messageId: string; eventId: string; sequence: number };
  runCount: number;
  olderRunsCursor: string | null;
  runs: {
    id: string;
    attempt: number;
    status: TaskStatus;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    provider: { protocol: ProviderProtocol; modelId: string } | null;
    usage: Usage | null;
    error: TaskFailure | null;
    output: { messageId: string; eventId: string; sequence: number } | null;
    continuation?: RunContinuation;
  }[];
}
type TaskRow = {
  id: string;
  conversation_id: string;
  status: TaskStatus;
  created_at: Date;
  bot_id: string;
  bot_version_id: string;
  version: number;
  configuration: BotConfiguration;
  execution_user_id: string;
  display_name: string;
  group_grant_id: string | null;
  trigger_event_id: string;
  message_id: string;
  sequence: string | number;
  command_hash: string;
  routing_algorithm: RoutingSummary['algorithm'] | null;
  routing_reason: RoutingSummary['reason'] | null;
};
export type TaskRunView = TaskView['runs'][number];
async function readRuns(
  connection: SqlConnection,
  id: string,
  limit: number,
  window?: RunHistoryCursor,
): Promise<TaskRunView[]> {
  const runs = (
    await connection.query<{
      id: string;
      attempt: number;
      status: TaskStatus;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
      protocol: ProviderProtocol | null;
      model_id: string | null;
      input_tokens: string | number | null;
      output_tokens: string | number | null;
      error_code: TaskFailure | null;
      output_event_id: string | null;
      message_id: string | null;
      sequence: string | number | null;
    }>(
      `SELECT r.*,e.message_id,e.sequence FROM task_runs r LEFT JOIN conversation_events e ON e.id=r.output_event_id WHERE r.task_id=$1 ${window ? 'AND r.attempt<$3::bigint AND r.attempt<=$4' : ''} ORDER BY r.attempt DESC LIMIT $2`,
      window ? [id, limit, window.before, window.horizon] : [id, limit],
    )
  ).rows;
  const views: TaskRunView[] = runs.map((run) => ({
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    provider: run.protocol ? { protocol: run.protocol, modelId: run.model_id! } : null,
    usage:
      run.input_tokens === null
        ? null
        : { inputTokens: Number(run.input_tokens), outputTokens: Number(run.output_tokens) },
    error: run.error_code,
    output: run.output_event_id
      ? { messageId: run.message_id!, eventId: run.output_event_id, sequence: Number(run.sequence) }
      : null,
  }));
  const continuations = await loadRunContinuations(
    connection,
    views.map((run) => ({
      id: run.id,
      protocol: run.provider?.protocol ?? null,
      modelId: run.provider?.modelId ?? null,
    })),
  );
  return views.map((run) => {
    const continuation = continuations.get(run.id);
    return continuation ? { ...run, continuation } : run;
  });
}
async function readTask(connection: SqlConnection, id: string): Promise<TaskView> {
  const row = (
    await connection.query<TaskRow>(
      `SELECT t.*,v.version,v.configuration,u.display_name,e.message_id,e.sequence,d.algorithm AS routing_algorithm,d.reason AS routing_reason FROM tasks t
     JOIN bot_versions v ON v.bot_id=t.bot_id AND v.id=t.bot_version_id
     JOIN users u ON u.id=t.execution_user_id JOIN conversation_events e ON e.id=t.trigger_event_id
     LEFT JOIN task_routing_decisions d ON d.task_id=t.id
     WHERE t.id=$1`,
      [id],
    )
  ).rows[0]!;
  const runs = await readRuns(connection, id, 1);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    createdAt: row.created_at,
    bot: {
      id: row.bot_id,
      name: row.configuration.name,
      versionId: row.bot_version_id,
      versionNumber: row.version,
    },
    executionUser: { id: row.execution_user_id, displayName: row.display_name },
    groupGrantId: row.group_grant_id,
    runCount: runs[0]!.attempt,
    olderRunsCursor:
      runs[0]!.attempt > 1
        ? encodeRunHistoryCursor({
            v: 1,
            conversationId: row.conversation_id,
            taskId: row.id,
            horizon: runs[0]!.attempt,
            before: runs[0]!.attempt,
          })
        : null,
    ...(row.routing_algorithm && row.routing_reason
      ? { routing: { algorithm: row.routing_algorithm, reason: row.routing_reason } }
      : {}),
    trigger: {
      messageId: row.message_id,
      eventId: row.trigger_event_id,
      sequence: Number(row.sequence),
    },
    runs,
  };
}
export class TaskService {
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
      if (
        error instanceof ConversationAccessError ||
        error instanceof GroupBotAccessError ||
        error instanceof GroupAccessError
      )
        throw new TaskAccessError();
      if (error instanceof ConversationConflictError) throw new TaskConflictError(error.code);
      // Keep the established Task admission error contract while the reusable
      // group selector expresses unavailable bindings in Bot domain terms.
      if (error instanceof BotModelError) {
        const code = {
          'not-accessible': 'connection_not_found',
          disabled: 'connection_disabled',
          'capability-unavailable': 'model_capability_required',
          'binding-changed': 'model_binding_changed',
        }[error.reason];
        throw new ProviderError(code);
      }
      throw error;
    } finally {
      connection.release();
    }
  }
  cancel(
    actorUserId: string,
    workspaceId: string,
    conversationId: string,
    taskId: string,
    input: unknown,
  ) {
    const access = taskAccess(actorUserId, workspaceId, conversationId),
      id = conversationUuid(taskId),
      command = cancellationCommand(input);
    return this.transaction(async (connection) => {
      const receipt = await cancelTask(connection, access, id, command, this.now);
      return { task: await readTask(connection, id), receipt };
    });
  }
  pause(
    actorUserId: string,
    workspaceId: string,
    conversationId: string,
    taskId: string,
    input: unknown,
  ) {
    const access = taskAccess(actorUserId, workspaceId, conversationId),
      id = conversationUuid(taskId),
      command = pauseCommand(input);
    return this.transaction(async (connection) => {
      const pause = await pauseTask(connection, access, id, command, this.now);
      return { task: await readTask(connection, id), pause };
    });
  }
  resume(
    actorUserId: string,
    workspaceId: string,
    conversationId: string,
    taskId: string,
    input: unknown,
  ) {
    const access = taskAccess(actorUserId, workspaceId, conversationId),
      id = conversationUuid(taskId),
      command = resumeCommand(input);
    return this.transaction(async (connection) => {
      const resume = await resumeTask(connection, access, id, command, this.now);
      return { task: await readTask(connection, id), resume };
    });
  }
  partialOutput(
    actorUserId: string,
    workspaceId: string,
    conversationId: string,
    taskId: string,
    runId: string,
  ): Promise<TaskPartialOutput> {
    const access = taskAccess(actorUserId, workspaceId, conversationId),
      id = conversationUuid(taskId),
      selectedRunId = conversationUuid(runId);
    return this.transaction(async (connection) => {
      await ConversationTransaction.lock(connection, access, this.now, 'inspect');
      const run = (
        await connection.query<{ status: TaskStatus; error_code: TaskFailure | null }>(
          'SELECT r.status,r.error_code FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND t.id=$2 AND t.workspace_id=$3 AND t.conversation_id=$4',
          [selectedRunId, id, access.workspaceId, access.conversationId],
        )
      ).rows[0];
      if (!run) throw new TaskAccessError();
      if (
        run.status !== 'cancelled' &&
        run.status !== 'paused' &&
        !(run.status === 'failed' && run.error_code === 'worker_interrupted')
      )
        throw new TaskConflictError('task_partial_state_conflict');
      const row = (
        await connection.query<{ body: string; end_byte: number }>(
          'SELECT body,end_byte FROM task_run_partial_outputs WHERE run_id=$1',
          [selectedRunId],
        )
      ).rows[0];
      return {
        conversationId: access.conversationId,
        taskId: id,
        runId: selectedRunId,
        partial: row ? { text: row.body, endByte: row.end_byte, interrupted: true } : null,
      };
    });
  }
  get(actorUserId: string, workspaceId: string, conversationId: string, taskId: string) {
    const access = taskAccess(actorUserId, workspaceId, conversationId),
      id = conversationUuid(taskId);
    return this.transaction(async (connection) => {
      await ConversationTransaction.lock(connection, access, this.now, 'inspect');
      const row = (
        await connection.query(
          'SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',
          [id, access.workspaceId, access.conversationId],
        )
      ).rows[0];
      if (!row) throw new TaskAccessError();
      return readTask(connection, id);
    });
  }
  runs(
    actorUserId: string,
    workspaceId: string,
    conversationId: string,
    taskId: string,
    query: unknown,
  ) {
    const access = taskAccess(actorUserId, workspaceId, conversationId),
      id = conversationUuid(taskId);
    const read = messageRead(query);
    if (read.limit > 50) throw new TaskInputError();
    if (query && typeof query === 'object' && !('limit' in query)) read.limit = 20;
    return this.transaction(async (connection) => {
      await ConversationTransaction.lock(connection, access, this.now, 'inspect');
      const latest = (
        await connection.query<{ attempt: number }>(
          'SELECT r.attempt FROM tasks t JOIN task_runs r ON r.task_id=t.id WHERE t.id=$1 AND t.workspace_id=$2 AND t.conversation_id=$3 ORDER BY r.attempt DESC LIMIT 1',
          [id, access.workspaceId, access.conversationId],
        )
      ).rows[0];
      if (!latest) throw new TaskAccessError();
      const cursor = runHistoryCursor(read.cursor, access.conversationId, id, latest.attempt);
      const rows = await readRuns(connection, id, read.limit + 1, cursor);
      const runs = rows.slice(0, read.limit);
      return {
        conversationId: access.conversationId,
        taskId: id,
        runs,
        nextCursor:
          rows.length > read.limit
            ? encodeRunHistoryCursor({ ...cursor, before: runs.at(-1)!.attempt })
            : null,
      };
    });
  }
  routing(actorUserId: string, workspaceId: string, conversationId: string, taskId: string) {
    const access = taskAccess(actorUserId, workspaceId, conversationId),
      id = conversationUuid(taskId);
    return this.transaction(async (connection) => {
      await ConversationTransaction.lock(connection, access, this.now, 'inspect');
      const row = (
        await connection.query<{ decision: RoutingDecision }>(
          'SELECT decision FROM task_routing_decisions WHERE task_id=$1 AND workspace_id=$2 AND conversation_id=$3',
          [id, access.workspaceId, access.conversationId],
        )
      ).rows[0];
      if (!row) throw new TaskAccessError();
      return structuredClone(row.decision);
    });
  }
  list(actorUserId: string, workspaceId: string, conversationId: string, query: unknown) {
    const access = taskAccess(actorUserId, workspaceId, conversationId);
    const read = messageRead(query);
    if (read.limit > 50) throw new TaskInputError();
    if (query && typeof query === 'object' && !('limit' in query)) read.limit = 20;
    return this.transaction(async (connection) => {
      await ConversationTransaction.lock(connection, access, this.now, 'inspect');
      const last = (
        await connection.query<{ last_sequence: string | number }>(
          'SELECT last_sequence FROM conversations WHERE id=$1',
          [access.conversationId],
        )
      ).rows[0]!;
      const cursor = messageCursor(read.cursor, access.conversationId, Number(last.last_sequence));
      const rows = (
        await connection.query<{ id: string; sequence: string | number }>(
          'SELECT t.id,e.sequence FROM tasks t JOIN conversation_events e ON e.id=t.trigger_event_id WHERE t.conversation_id=$1 AND e.sequence>$2 AND e.sequence<=$3 ORDER BY e.sequence LIMIT $4',
          [access.conversationId, cursor.after, cursor.horizon, read.limit + 1],
        )
      ).rows;
      const selected = rows.slice(0, read.limit),
        tasks: TaskView[] = [];
      for (const row of selected) tasks.push(await readTask(connection, row.id));
      return {
        conversationId: access.conversationId,
        tasks,
        nextCursor:
          rows.length > read.limit
            ? encodeMessageCursor({ ...cursor, after: Number(selected.at(-1)!.sequence) })
            : null,
      };
    });
  }
  submit(actorUserId: string, workspaceId: string, conversationId: string, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskInputError();
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !['idempotencyKey', 'body', 'groupGrantId'].includes(key)) ||
      typeof value.idempotencyKey !== 'string' ||
      !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey) ||
      typeof value.body !== 'string' ||
      !value.body.trim() ||
      value.body.length > 32000
    )
      throw new TaskInputError();
    const command = { idempotencyKey: value.idempotencyKey, body: value.body };
    const groupGrantId =
      value.groupGrantId === undefined ? null : conversationUuid(value.groupGrantId);
    const access: ConversationAccess = Object.freeze({
      actorUserId: conversationUuid(actorUserId),
      workspaceId: conversationUuid(workspaceId),
      conversationId: conversationUuid(conversationId),
    });
    return this.transaction(async (connection) => {
      const admitted = await admitTaskSubmission(
        connection,
        access,
        { ...command, groupGrantId },
        this.now,
      );
      if (admitted.priorTaskId) return readTask(connection, admitted.priorTaskId);
      const target = admitted.target;
      const conversation = target.conversation;
      const selectedGrantId = target.groupGrantId;
      const hash = taskSubmissionHash(command.body, selectedGrantId);
      const bot = {
        id: target.botId,
        version_id: target.versionId,
        configuration: target.configuration,
      };
      const trigger = await conversation.appendTaskTrigger({
        ...command,
        groupGrantId: selectedGrantId,
      });
      const id = randomUUID(),
        runId = randomUUID(),
        occurredAt = this.now();
      await connection.query(
        "INSERT INTO tasks(id,workspace_id,conversation_id,bot_id,bot_version_id,execution_user_id,trigger_event_id,command_hash,status,created_at,group_grant_id,root_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$1)",
        [
          id,
          access.workspaceId,
          access.conversationId,
          bot.id,
          bot.version_id,
          access.actorUserId,
          trigger.receipt.eventId,
          hash,
          occurredAt,
          selectedGrantId,
        ],
      );
      await connection.query(
        "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,1,'queued',$3)",
        [runId, id, occurredAt],
      );
      if (admitted.decision) {
        await connection.query(
          'INSERT INTO task_routing_decisions(task_id,workspace_id,conversation_id,group_id,request_hash,algorithm,reason,decision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
          [
            id,
            access.workspaceId,
            access.conversationId,
            admitted.groupId,
            admitted.requestHash,
            admitted.decision.algorithm,
            admitted.decision.reason,
            JSON.stringify(admitted.decision),
            occurredAt,
          ],
        );
        await connection.query(
          "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.routed',$2,$3,$4::jsonb)",
          [
            randomUUID(),
            access.actorUserId,
            occurredAt,
            JSON.stringify({
              workspaceId: access.workspaceId,
              conversationId: access.conversationId,
              taskId: id,
              botId: bot.id,
              botVersionId: bot.version_id,
              grantId: selectedGrantId,
              reason: admitted.decision.reason,
              algorithm: admitted.decision.algorithm,
            }),
          ],
        );
      }
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.queued',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          access.actorUserId,
          this.now(),
          JSON.stringify({
            workspaceId: access.workspaceId,
            conversationId: access.conversationId,
            taskId: id,
            runId,
            botId: bot.id,
            botVersionId: bot.version_id,
            triggerEventId: trigger.receipt.eventId,
            attempt: 1,
          }),
        ],
      );
      await appendQueuedRunState(connection, runId, this.now);
      return readTask(connection, id);
    });
  }
  retry(
    actorUserId: string,
    workspaceId: string,
    conversationId: string,
    taskId: string,
    input: unknown,
  ) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskInputError();
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !['idempotencyKey', 'expectedRunId'].includes(key)) ||
      typeof value.idempotencyKey !== 'string' ||
      !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey)
    )
      throw new TaskInputError();
    const access = taskAccess(actorUserId, workspaceId, conversationId);
    const id = conversationUuid(taskId),
      expectedRunId = conversationUuid(value.expectedRunId);
    const key = value.idempotencyKey;
    return this.transaction(async (connection) => {
      const task = (
        await connection.query<{
          execution_user_id: string;
          bot_version_id: string;
          group_grant_id: string | null;
        }>(
          'SELECT execution_user_id,bot_version_id,group_grant_id FROM tasks WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',
          [id, access.workspaceId, access.conversationId],
        )
      ).rows[0];
      if (!task || task.execution_user_id !== access.actorUserId) throw new TaskAccessError();
      const target = await admitTaskTarget(
        connection,
        access,
        task.group_grant_id,
        this.now,
        task.bot_version_id,
      );
      const activeAncestry = await lockTaskAncestry(connection, id);
      const locked = (
        await connection.query<{ status: TaskStatus }>(
          'SELECT status FROM tasks WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0]!;
      const current = (
        await connection.query<{ id: string; attempt: number; status: TaskStatus }>(
          'SELECT id,attempt,status FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE',
          [id],
        )
      ).rows[0]!;
      const prior = (
        await connection.query<{ expected_run_id: string; run_id: string; attempt: number }>(
          'SELECT c.expected_run_id,c.run_id,r.attempt FROM task_retry_commands c JOIN task_runs r ON r.id=c.run_id AND r.task_id=c.task_id WHERE c.task_id=$1 AND c.actor_user_id=$2 AND c.idempotency_key=$3',
          [id, access.actorUserId, key],
        )
      ).rows[0];
      if (prior && prior.expected_run_id !== expectedRunId) throw new TaskConflictError();
      if (!prior) {
        if (!activeAncestry) throw new TaskConflictError('task_retry_cancelled_ancestor');
        if (locked.status !== 'failed' || current.status !== 'failed')
          throw new TaskConflictError('task_retry_state_conflict');
        if (current.id !== expectedRunId) throw new TaskConflictError('task_retry_run_conflict');
        if (current.attempt >= 2147483647) throw new TaskConflictError('task_attempt_exhausted');
      }
      const binding = target.configuration.modelBinding;
      await admitUsableModel(
        connection,
        { actorUserId: access.actorUserId, scope: binding.scope },
        { connectionId: binding.connectionId, expectedModelId: binding.modelId },
      );
      if (prior)
        return {
          task: await readTask(connection, id),
          receipt: { runId: prior.run_id, attempt: prior.attempt },
        };
      const runId = randomUUID(),
        commandId = randomUUID(),
        attempt = current.attempt + 1,
        occurredAt = this.now();
      await connection.query(
        "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,$3,'queued',$4)",
        [runId, id, attempt, occurredAt],
      );
      await connection.query(
        'INSERT INTO task_retry_commands(id,task_id,actor_user_id,expected_run_id,run_id,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [commandId, id, access.actorUserId, expectedRunId, runId, key, occurredAt],
      );
      await connection.query("UPDATE tasks SET status='queued' WHERE id=$1", [id]);
      await appendQueuedRunState(connection, runId, this.now);
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.retried',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          access.actorUserId,
          this.now(),
          JSON.stringify({
            workspaceId: access.workspaceId,
            conversationId: access.conversationId,
            taskId: id,
            retryCommandId: commandId,
            previousRunId: current.id,
            runId,
            attempt,
            botId: target.botId,
            botVersionId: target.versionId,
          }),
        ],
      );
      return { task: await readTask(connection, id), receipt: { runId, attempt } };
    });
  }
}
function taskAccess(
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
): ConversationAccess {
  return Object.freeze({
    actorUserId: conversationUuid(actorUserId),
    workspaceId: conversationUuid(workspaceId),
    conversationId: conversationUuid(conversationId),
  });
}

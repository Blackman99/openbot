import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import type { BotConfiguration } from '../bots/service.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { admitTaskTarget } from './admission.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { messageCursor, encodeMessageCursor } from '../conversations/cursor.js';
import {
  conversationUuid,
  ConversationAccessError,
  ConversationConflictError,
  type ConversationAccess,
  messageRead,
} from '../conversations/service.js';
import { admitUsableModel } from '../providers/postgres-model-admission.js';
import type { ProviderProtocol } from '../providers/model-events.js';
import type { TaskFailure, Usage } from './queue.js';

export class TaskInputError extends Error {}
export class TaskAccessError extends Error {}
export class TaskConflictError extends Error {
  constructor(readonly code = 'idempotency_conflict') {
    super(code);
  }
}
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';
export interface TaskView {
  id: string;
  conversationId: string;
  status: TaskStatus;
  createdAt: Date;
  bot: { id: string; name: string; versionId: string; versionNumber: number };
  executionUser: { id: string; displayName: string };
  groupGrantId: string | null;
  trigger: { messageId: string; eventId: string; sequence: number };
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
};
async function readTask(connection: SqlConnection, id: string): Promise<TaskView> {
  const row = (
    await connection.query<TaskRow>(
      `SELECT t.*,v.version,v.configuration,u.display_name,e.message_id,e.sequence FROM tasks t
     JOIN bot_versions v ON v.bot_id=t.bot_id AND v.id=t.bot_version_id
     JOIN users u ON u.id=t.execution_user_id JOIN conversation_events e ON e.id=t.trigger_event_id
     WHERE t.id=$1`,
      [id],
    )
  ).rows[0]!;
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
      'SELECT r.*,e.message_id,e.sequence FROM task_runs r LEFT JOIN conversation_events e ON e.id=r.output_event_id WHERE r.task_id=$1 ORDER BY r.attempt',
      [id],
    )
  ).rows;
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
    trigger: {
      messageId: row.message_id,
      eventId: row.trigger_event_id,
      sequence: Number(row.sequence),
    },
    runs: runs.map((run) => ({
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
        ? {
            messageId: run.message_id!,
            eventId: run.output_event_id,
            sequence: Number(run.sequence),
          }
        : null,
    })),
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
      if (error instanceof ConversationAccessError || error instanceof GroupBotAccessError)
        throw new TaskAccessError();
      if (error instanceof ConversationConflictError) throw new TaskConflictError(error.code);
      throw error;
    } finally {
      connection.release();
    }
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
      const target = await admitTaskTarget(connection, access, groupGrantId, this.now);
      const conversation = target.conversation;
      const hash = createHash('sha256')
        .update(JSON.stringify({ type: 'task.submit', body: command.body, grantId: groupGrantId }))
        .digest('hex');
      const prior = (
        await connection.query<{ id: string }>(
          'SELECT id FROM conversation_events WHERE conversation_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
          [access.conversationId, access.actorUserId, command.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        const task = (
          await connection.query<{ id: string; command_hash: string }>(
            'SELECT id,command_hash FROM tasks WHERE trigger_event_id=$1',
            [prior.id],
          )
        ).rows[0];
        if (!task || task.command_hash !== hash) throw new TaskConflictError();
        return readTask(connection, task.id);
      }
      const bot = {
        id: target.botId,
        version_id: target.versionId,
        configuration: target.configuration,
      };
      await admitUsableModel(
        connection,
        { actorUserId: access.actorUserId, scope: bot.configuration.modelBinding.scope },
        {
          connectionId: bot.configuration.modelBinding.connectionId,
          expectedModelId: bot.configuration.modelBinding.modelId,
        },
      );
      const trigger = await conversation.appendTaskTrigger({ ...command, groupGrantId });
      const id = randomUUID(),
        runId = randomUUID(),
        occurredAt = this.now();
      await connection.query(
        "INSERT INTO tasks(id,workspace_id,conversation_id,bot_id,bot_version_id,execution_user_id,trigger_event_id,command_hash,status,created_at,group_grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10)",
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
          groupGrantId,
        ],
      );
      await connection.query(
        "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,1,'queued',$3)",
        [runId, id, occurredAt],
      );
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
      return readTask(connection, id);
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

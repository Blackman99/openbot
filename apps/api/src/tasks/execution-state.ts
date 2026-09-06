import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { ProviderProtocol } from '../providers/model-events.js';
import type { ExecutionState } from '../conversations/stream-protocol.js';
import type { RoutingSummary } from '../routing/matcher.js';
import type { TaskFailure } from './queue.js';
import { readStoredTokenUsage } from './token-usage.js';
import type { TaskStatus } from './service.js';
import { loadRunContinuation, wireContinuation } from './continuation.js';

// The caller already owns the conversation admission/lock. Select one retained
// Run, with only fields permitted in a delivery snapshot or bounded bootstrap.
export async function readRunExecution(connection: SqlConnection, runId: string) {
  const row = (
    await connection.query<{
      id: string;
      task_id: string;
      workspace_id: string;
      conversation_id: string;
      attempt: number;
      status: TaskStatus;
      task_status: TaskStatus;
      bot_id: string;
      bot_version_id: string;
      bot_name: string;
      version: number;
      execution_user_id: string;
      display_name: string;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
      protocol: ProviderProtocol | null;
      model_id: string | null;
      input_tokens: string | number | null;
      output_tokens: string | number | null;
      usage_estimated: boolean | null;
      error_code: TaskFailure | null;
      output_event_id: string | null;
      message_id: string | null;
      sequence: string | number | null;
      routing_algorithm: RoutingSummary['algorithm'] | null;
      routing_reason: RoutingSummary['reason'] | null;
    }>(
      `SELECT r.*,t.workspace_id,t.conversation_id,t.status AS task_status,t.bot_id,t.bot_version_id,
      t.execution_user_id,v.configuration->>'name' AS bot_name,v.version,u.display_name,e.message_id,e.sequence,
      d.algorithm AS routing_algorithm,d.reason AS routing_reason
      FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN bot_versions v ON v.id=t.bot_version_id AND v.bot_id=t.bot_id
      JOIN users u ON u.id=t.execution_user_id LEFT JOIN conversation_events e ON e.id=r.output_event_id
      LEFT JOIN task_routing_decisions d ON d.task_id=t.id AND d.workspace_id=t.workspace_id
        AND d.conversation_id=t.conversation_id AND t.group_grant_id IS NOT NULL WHERE r.id=$1`,
      [runId],
    )
  ).rows[0];
  if (!row) return undefined;
  const execution: ExecutionState = {
    taskId: row.task_id,
    runId: row.id,
    attempt: row.attempt,
    taskStatus: row.task_status,
    runStatus: row.status,
    bot: {
      id: row.bot_id,
      displayName: row.bot_name,
      versionId: row.bot_version_id,
      versionNumber: row.version,
    },
    executionUser: { id: row.execution_user_id, displayName: row.display_name },
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    provider: row.protocol ? { protocol: row.protocol, modelId: row.model_id! } : null,
    usage: readStoredTokenUsage(row.input_tokens, row.output_tokens, row.usage_estimated),
    error: row.error_code,
    output: row.output_event_id
      ? { messageId: row.message_id!, eventId: row.output_event_id, sequence: Number(row.sequence) }
      : null,
    ...(row.routing_algorithm && row.routing_reason
      ? { routing: { algorithm: row.routing_algorithm, reason: row.routing_reason } }
      : {}),
  };
  const continuation = await loadRunContinuation(connection, {
    id: row.id,
    protocol: row.protocol,
    modelId: row.model_id,
  });
  if (continuation) execution.continuation = wireContinuation(continuation);
  return { workspaceId: row.workspace_id, conversationId: row.conversation_id, execution };
}

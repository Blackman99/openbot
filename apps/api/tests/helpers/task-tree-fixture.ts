import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../src/auth/postgres-auth-repository.js';
import { ConversationTransaction } from '../../src/conversations/postgres-repository.js';
import { appendQueuedRunState } from '../../src/conversations/append-event.js';
import { taskSubmissionHash } from '../../src/tasks/submission-admission.js';

// Structural child fixture, not a delegation API: every child gets its own
// legitimately authorized human trigger, exact grant, first Run and receipt.
// No trigger reuse, reparenting, disabled guards or rewritten terminal history.
export async function createQueuedTaskChild(
  pool: SqlPool,
  input: {
    workspaceId: string;
    conversationId: string;
    executionUserId: string;
    botId: string;
    botVersionId: string;
    groupGrantId: string;
    parentTaskId: string;
  },
) {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const conversation = await ConversationTransaction.lock(connection, {
      actorUserId: input.executionUserId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
    });
    const parent = (
      await connection.query<{ root_task_id: string; depth: number }>(
        'SELECT root_task_id,depth FROM tasks WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',
        [input.parentTaskId, input.workspaceId, input.conversationId],
      )
    ).rows[0]!;
    await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [parent.root_task_id]);
    const id = randomUUID(),
      runId = randomUUID(),
      body = 'Child evidence ' + id,
      now = new Date();
    const trigger = await conversation.appendTaskTrigger({
      idempotencyKey: id,
      body,
      groupGrantId: input.groupGrantId,
    });
    await connection.query(
      "INSERT INTO tasks(id,workspace_id,conversation_id,bot_id,bot_version_id,execution_user_id,trigger_event_id,command_hash,status,created_at,group_grant_id,root_task_id,parent_task_id,depth) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13)",
      [
        id,
        input.workspaceId,
        input.conversationId,
        input.botId,
        input.botVersionId,
        input.executionUserId,
        trigger.receipt.eventId,
        taskSubmissionHash(body, input.groupGrantId),
        now,
        input.groupGrantId,
        parent.root_task_id,
        input.parentTaskId,
        parent.depth + 1,
      ],
    );
    await connection.query(
      "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,1,'queued',$3)",
      [runId, id, now],
    );
    await connection.query(
      "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.queued',$2,$3,$4::jsonb)",
      [
        randomUUID(),
        input.executionUserId,
        now,
        JSON.stringify({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          taskId: id,
          runId,
          botId: input.botId,
          botVersionId: input.botVersionId,
          triggerEventId: trigger.receipt.eventId,
          attempt: 1,
        }),
      ],
    );
    await appendQueuedRunState(connection, runId, () => new Date());
    await connection.query('COMMIT');
    return { id, runId };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

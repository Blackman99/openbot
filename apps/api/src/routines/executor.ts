import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { appendQueuedRunState } from '../conversations/append-event.js';
import { openGroupMembershipConversation } from '../conversations/postgres-repository.js';
import { ConversationAccessError, ConversationConflictError } from '../conversations/service.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { GroupAccessError, GroupArchivedError } from '../groups/service.js';
import { BotModelError } from '../bots/service.js';
import { ProviderError } from '../providers/url-policy.js';
import {
  loadExecutionLimitPolicies,
  persistTaskLimitSnapshot,
  resolveExecutionLimits,
  taskPolicyFromBotLimits,
} from '../tasks/execution-limits.js';
import { admitTaskSubmission, taskSubmissionHash } from '../tasks/submission-admission.js';
import { oneTimeOccurrenceKey, type RoutineRoutingPolicy, type RoutineStatus } from './service.js';

function uniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

type DueRoutine = {
  id: string;
  workspace_id: string;
  group_id: string;
  owner_user_id: string;
  prompt: string;
  lead_grant_id: string | null;
  routing_policy: RoutineRoutingPolicy;
  execute_at: Date;
  expires_at: Date;
  max_cost_micros: string | number;
  status: RoutineStatus;
};

export type RoutineExecutionResult =
  | { handled: false }
  | {
      handled: true;
      routineId: string;
      outcome: 'created' | 'expired';
      taskId?: string;
      conversationId?: string;
    };

export class RoutineExecutor {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<RoutineExecutionResult> {
    const due = await this.findDue();
    if (!due) return { handled: false };
    try {
      return await this.executeDue(due.id);
    } catch (error) {
      if (uniqueViolation(error)) return { handled: false };
      throw error;
    }
  }

  async executeDue(routineId: string): Promise<RoutineExecutionResult> {
    return this.transaction(async (connection) => {
      const occurredAt = this.now();
      const preview = (
        await connection.query<{ group_id: string; workspace_id: string; owner_user_id: string }>(
          'SELECT group_id,workspace_id,owner_user_id FROM routines WHERE id=$1',
          [routineId],
        )
      ).rows[0];
      if (!preview) return { handled: false };
      try {
        await lockAuthorizedGroup(
          connection,
          {
            actorId: preview.owner_user_id,
            workspaceId: preview.workspace_id,
            groupId: preview.group_id,
          },
          'content',
        );
      } catch (error) {
        if (error instanceof GroupAccessError || error instanceof GroupArchivedError)
          return { handled: false };
        throw error;
      }
      const routine = (
        await connection.query<DueRoutine>(
          'SELECT * FROM routines WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [routineId, preview.workspace_id],
        )
      ).rows[0];
      if (!routine || routine.status !== 'active') return { handled: false };
      if (routine.execute_at.getTime() > occurredAt.getTime()) return { handled: false };

      const occurrenceKey = oneTimeOccurrenceKey(routine.execute_at);
      const occurrenceId = randomUUID();

      if (routine.expires_at.getTime() <= occurredAt.getTime()) {
        try {
          await connection.query(
            `INSERT INTO routine_occurrences(
              id,routine_id,workspace_id,occurrence_key,task_id,conversation_id,outcome,created_at
            ) VALUES($1,$2,$3,$4,NULL,NULL,'expired',$5)`,
            [occurrenceId, routine.id, routine.workspace_id, occurrenceKey, occurredAt],
          );
        } catch (error) {
          if (uniqueViolation(error)) return { handled: false };
          throw error;
        }
        await connection.query(
          `UPDATE routines SET status='expired',updated_at=$2 WHERE id=$1 AND status='active'`,
          [routine.id, occurredAt],
        );
        await connection.query(
          "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'routine.expired',$2,$3,$4::jsonb)",
          [
            randomUUID(),
            routine.owner_user_id,
            occurredAt,
            JSON.stringify({
              workspaceId: routine.workspace_id,
              groupId: routine.group_id,
              routineId: routine.id,
              occurrenceKey,
            }),
          ],
        );
        return { handled: true, routineId: routine.id, outcome: 'expired' };
      }

      try {
        await connection.query(
          `INSERT INTO routine_occurrences(
            id,routine_id,workspace_id,occurrence_key,task_id,conversation_id,outcome,created_at
          ) VALUES($1,$2,$3,$4,NULL,NULL,'created',$5)`,
          [occurrenceId, routine.id, routine.workspace_id, occurrenceKey, occurredAt],
        );
      } catch (error) {
        if (uniqueViolation(error)) return { handled: false };
        throw error;
      }

      const conversation = await openGroupMembershipConversation(
        connection,
        routine.owner_user_id,
        routine.workspace_id,
        routine.group_id,
        () => occurredAt,
      );
      const access = {
        actorUserId: routine.owner_user_id,
        workspaceId: routine.workspace_id,
        conversationId: conversation.id,
      };
      const groupGrantId = routine.routing_policy === 'lead' ? routine.lead_grant_id : null;
      const idempotencyKey = `routine:${routine.id}:${occurrenceKey}`;
      let admitted;
      try {
        admitted = await admitTaskSubmission(
          connection,
          access,
          {
            idempotencyKey,
            body: routine.prompt,
            groupGrantId,
          },
          () => occurredAt,
        );
      } catch (error) {
        if (
          error instanceof ConversationAccessError ||
          error instanceof ConversationConflictError ||
          error instanceof GroupBotAccessError ||
          error instanceof BotModelError ||
          error instanceof ProviderError
        ) {
          throw error;
        }
        throw error;
      }
      if (admitted.priorTaskId) {
        await connection.query(
          `UPDATE routine_occurrences SET task_id=$2,conversation_id=$3 WHERE id=$1`,
          [occurrenceId, admitted.priorTaskId, conversation.id],
        );
        await connection.query(
          `UPDATE routines SET status='completed',updated_at=$2 WHERE id=$1 AND status='active'`,
          [routine.id, occurredAt],
        );
        return {
          handled: true,
          routineId: routine.id,
          outcome: 'created',
          taskId: admitted.priorTaskId,
          conversationId: conversation.id,
        };
      }

      const target = admitted.target;
      const selectedGrantId = target.groupGrantId;
      const hash = taskSubmissionHash(routine.prompt, selectedGrantId);
      const trigger = await target.conversation.appendTaskTrigger({
        idempotencyKey,
        body: routine.prompt,
        groupGrantId: selectedGrantId,
      });
      const taskId = randomUUID();
      const runId = randomUUID();
      const maxCostMicros = Number(routine.max_cost_micros);
      const taskPolicy = {
        ...taskPolicyFromBotLimits(target.configuration.limits),
        maxCostMicros,
      };
      await connection.query(
        `INSERT INTO tasks(
          id,workspace_id,conversation_id,bot_id,bot_version_id,execution_user_id,trigger_event_id,command_hash,
          status,created_at,group_grant_id,root_task_id,execution_policy
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$1,$11::jsonb)`,
        [
          taskId,
          access.workspaceId,
          access.conversationId,
          target.botId,
          target.versionId,
          access.actorUserId,
          trigger.receipt.eventId,
          hash,
          occurredAt,
          selectedGrantId,
          JSON.stringify(taskPolicy),
        ],
      );
      await connection.query(
        "INSERT INTO task_runs(id,task_id,attempt,status,created_at) VALUES($1,$2,1,'queued',$3)",
        [runId, taskId, occurredAt],
      );
      const policies = await loadExecutionLimitPolicies(
        connection,
        access.workspaceId,
        admitted.groupId,
      );
      await persistTaskLimitSnapshot(
        connection,
        taskId,
        resolveExecutionLimits({
          ...policies,
          task: taskPolicy,
        }),
        occurredAt,
      );
      if (admitted.decision) {
        await connection.query(
          'INSERT INTO task_routing_decisions(task_id,workspace_id,conversation_id,group_id,request_hash,algorithm,reason,decision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
          [
            taskId,
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
              taskId,
              botId: target.botId,
              botVersionId: target.versionId,
              grantId: selectedGrantId,
              reason: admitted.decision.reason,
              algorithm: admitted.decision.algorithm,
              origin: 'routine',
              routineId: routine.id,
            }),
          ],
        );
      }
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'task.queued',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          access.actorUserId,
          occurredAt,
          JSON.stringify({
            workspaceId: access.workspaceId,
            conversationId: access.conversationId,
            taskId,
            runId,
            botId: target.botId,
            botVersionId: target.versionId,
            triggerEventId: trigger.receipt.eventId,
            attempt: 1,
            origin: 'routine',
            routineId: routine.id,
            occurrenceKey,
          }),
        ],
      );
      await appendQueuedRunState(connection, runId, () => occurredAt);
      await connection.query(
        `UPDATE routine_occurrences SET task_id=$2,conversation_id=$3 WHERE id=$1`,
        [occurrenceId, taskId, conversation.id],
      );
      await connection.query(
        `UPDATE routines SET status='completed',updated_at=$2 WHERE id=$1 AND status='active'`,
        [routine.id, occurredAt],
      );
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'routine.executed',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          routine.owner_user_id,
          occurredAt,
          JSON.stringify({
            workspaceId: routine.workspace_id,
            groupId: routine.group_id,
            routineId: routine.id,
            occurrenceKey,
            taskId,
            conversationId: conversation.id,
          }),
        ],
      );
      return {
        handled: true,
        routineId: routine.id,
        outcome: 'created',
        taskId,
        conversationId: conversation.id,
      };
    });
  }

  private async findDue(): Promise<{ id: string } | undefined> {
    const now = this.now();
    const connection = await this.pool.connect();
    try {
      const row = (
        await connection.query<{ id: string }>(
          `SELECT id FROM routines
           WHERE status='active' AND execute_at<=$1
           ORDER BY execute_at,id LIMIT 1`,
          [now],
        )
      ).rows[0];
      return row;
    } finally {
      connection.release();
    }
  }

  private async transaction<T>(work: (connection: SqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await work(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}

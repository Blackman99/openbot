import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { ConversationAccessError } from '../conversations/service.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { BotAccessError } from '../bots/service.js';
import { ProviderError } from '../providers/url-policy.js';
import { admitExecutionModel, admitUsableModel } from '../providers/postgres-model-admission.js';
import type { ModelInput } from '../providers/model-events.js';
import { currentPage } from '../conversations/projection.js';
import {
  appendBotResult,
  appendAssistantDelta,
  appendRunningRunState,
  appendCompletedRunState,
  appendFailedRunState,
} from '../conversations/append-event.js';
import { admitTaskTarget } from './admission.js';
import { TaskPartialOutputLimitError } from './partial-output.js';
import { lockTaskAncestry, taskAncestryIsActive } from './tree.js';
import {
  selectRunMemoryContribution,
  persistRunMemoryReferences,
  assertRunMemoryReferencesCurrent,
  MemoryContextLimitError,
  type RunMemoryContribution,
} from '../memories/run-context.js';

export type TaskFailure =
  | 'execution_forbidden'
  | 'model_unavailable'
  | 'provider_failed'
  | 'execution_timeout'
  | 'output_limit'
  | 'context_limit'
  | 'worker_stopped';
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
type Candidate = {
  id: string;
  attempt: number;
  task_id: string;
  workspace_id: string;
  conversation_id: string;
  execution_user_id: string;
  bot_id: string;
  bot_version_id: string;
  group_grant_id: string | null;
  trigger_sequence: string | number;
};
export interface TaskClaim {
  runId: string;
  taskId: string;
  claimToken: string;
  deadlineAt: Date;
  provider: Awaited<ReturnType<typeof admitExecutionModel>>;
  messages: ModelInput['messages'];
  maxTotalTokens: number;
}
class ContextLimitError extends Error {}
class PublicationDeadlineElapsed extends Error {}
export class TaskPublicationError extends Error {
  constructor(readonly code: TaskFailure) {
    super(code);
  }
}
function admissionFailure(error: unknown): TaskFailure | undefined {
  if (
    error instanceof ConversationAccessError ||
    error instanceof GroupBotAccessError ||
    error instanceof BotAccessError
  )
    return 'execution_forbidden';
  if (error instanceof ProviderError) return 'model_unavailable';
  if (error instanceof ContextLimitError || error instanceof MemoryContextLimitError)
    return 'context_limit';
  return undefined;
}
export class TaskQueue {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async transaction<T>(action: (connection: SqlConnection) => Promise<T>) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await action(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  private async candidate(connection: SqlConnection, runId?: string) {
    return (
      await connection.query<Candidate>(
        `SELECT r.id,r.attempt,r.task_id,t.workspace_id,t.conversation_id,t.execution_user_id,t.bot_id,t.bot_version_id,t.group_grant_id,e.sequence AS trigger_sequence FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN conversation_events e ON e.id=t.trigger_event_id
       WHERE ${runId ? 'r.id=$1' : "r.status='queued'"} ORDER BY r.created_at,r.id LIMIT 1`,
        runId ? [runId] : [],
      )
    ).rows[0];
  }
  private async lockRun(connection: SqlConnection, task: Candidate) {
    if (!(await lockTaskAncestry(connection, task.task_id))) return undefined;
    return (
      await connection.query<{
        status: string;
        claim_token: string | null;
        deadline_at: Date | null;
      }>(
        'SELECT r.status,r.claim_token,r.deadline_at FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.task_id=$2 AND r.status=t.status AND r.attempt=(SELECT MAX(attempt) FROM task_runs WHERE task_id=$2) FOR UPDATE',
        [task.id, task.task_id],
      )
    ).rows[0];
  }
  // Structural locks never authorize content. The immutable persisted target
  // provides the order even when the execution actor/grant is now forbidden.
  // Failure-state publication must not acquire a conversation after Task/Run.
  private async lockStructure(connection: SqlConnection, task: Candidate) {
    const subject = (
      await connection.query<{ group_id: string | null }>(
        'SELECT group_id FROM conversations WHERE workspace_id=$1 AND id=$2',
        [task.workspace_id, task.conversation_id],
      )
    ).rows[0];
    if (!subject) throw new Error('Retained Task conversation missing');
    await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [task.workspace_id]);
    if (subject.group_id)
      await connection.query('SELECT id FROM groups WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        task.workspace_id,
        subject.group_id,
      ]);
    await connection.query('SELECT id FROM bots WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
      task.workspace_id,
      task.bot_id,
    ]);
    await connection.query(
      'SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [task.workspace_id, task.conversation_id],
    );
  }
  private access(task: Candidate) {
    return {
      actorUserId: task.execution_user_id,
      workspaceId: task.workspace_id,
      conversationId: task.conversation_id,
    };
  }
  private async audit(connection: SqlConnection, task: Candidate, type: string, metadata: object) {
    await connection.query(
      'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
      [
        randomUUID(),
        type,
        task.execution_user_id,
        this.now(),
        JSON.stringify({
          workspaceId: task.workspace_id,
          conversationId: task.conversation_id,
          taskId: task.task_id,
          runId: task.id,
          attempt: task.attempt,
          ...metadata,
        }),
      ],
    );
  }
  private async fail(
    connection: SqlConnection,
    task: Candidate,
    error: TaskFailure,
    usage: Usage | null = null,
  ) {
    await connection.query(
      "UPDATE task_runs SET status='failed',finished_at=$2,error_code=$3,input_tokens=$4,output_tokens=$5 WHERE id=$1",
      [task.id, this.now(), error, usage?.inputTokens ?? null, usage?.outputTokens ?? null],
    );
    await connection.query("UPDATE tasks SET status='failed' WHERE id=$1", [task.task_id]);
    await this.audit(connection, task, 'task.failed', { error });
    await appendFailedRunState(connection, task.id, this.now);
  }
  async isClaimActive(claim: TaskClaim): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      return (
        (
          await connection.query(
            `SELECT r.id FROM task_runs r JOIN tasks t ON t.id=r.task_id
           WHERE r.id=$1 AND r.task_id=$2 AND r.claim_token=$3
             AND r.status='running' AND t.status='running' AND r.deadline_at>$4
             AND r.attempt=(SELECT MAX(attempt) FROM task_runs WHERE task_id=$2)`,
            [claim.runId, claim.taskId, claim.claimToken, this.now()],
          )
        ).rows.length === 1 && (await taskAncestryIsActive(connection, claim.taskId))
      );
    } finally {
      connection.release();
    }
  }
  async claimNext(): Promise<{ handled: boolean; claim?: TaskClaim }> {
    return this.transaction(async (connection) => {
      // Observe the queue before row locking, then acquire scope locks in the
      // shared order. Competing workers recheck this candidate after waiting.
      const task = await this.candidate(connection);
      if (!task) return { handled: false };
      await this.lockStructure(connection, task);
      let target: Awaited<ReturnType<typeof admitTaskTarget>>;
      try {
        target = await admitTaskTarget(
          connection,
          this.access(task),
          task.group_grant_id,
          this.now,
          task.bot_version_id,
        );
      } catch (error) {
        const code = admissionFailure(error);
        if (!code) throw error;
        const run = await this.lockRun(connection, task);
        if (run?.status !== 'queued') return { handled: false };
        await this.fail(connection, task, code);
        return { handled: true };
      }
      const run = await this.lockRun(connection, task);
      if (run?.status !== 'queued') return { handled: false };
      let provider: TaskClaim['provider'];
      let memory: RunMemoryContribution;
      const messages: ModelInput['messages'] = [
        { role: 'system', content: target.configuration.instructions },
      ];
      try {
        memory = await selectRunMemoryContribution(connection, task.id, this.now);
        messages.push(...memory.messages);
        let after = target.lowerBound - 1,
          bytes = Buffer.byteLength(target.configuration.instructions) + memory.bytes,
          count = memory.itemCount;
        if (bytes > 1048576 || count > 1000) throw new ContextLimitError();
        while (true) {
          const page = await currentPage(
            connection,
            task.conversation_id,
            after,
            Number(task.trigger_sequence),
            100,
            task.execution_user_id,
            false,
          );
          for (const message of page.messages) {
            count++;
            if (count > 1000) throw new ContextLimitError();
            if (!message.deleted && message.body) {
              bytes += Buffer.byteLength(message.body);
              if (bytes > 1048576) throw new ContextLimitError();
              messages.push({
                role: 'kind' in message.author ? 'assistant' : 'user',
                content: message.body,
              });
            }
          }
          if (!page.hasMore) break;
          after = page.messages.at(-1)!.creationSequence;
        }
        const binding = target.configuration.modelBinding;
        provider = await admitExecutionModel(
          connection,
          { actorUserId: task.execution_user_id, scope: binding.scope },
          { connectionId: binding.connectionId, expectedModelId: binding.modelId },
        );
      } catch (error) {
        const code = admissionFailure(error);
        if (!code) throw error;
        await this.fail(connection, task, code);
        return { handled: true };
      }
      const claimToken = randomUUID(),
        startedAt = this.now(),
        deadlineAt = new Date(
          startedAt.getTime() + target.configuration.limits.maxDurationSeconds * 1000,
        );
      const claimed = await connection.query(
        "UPDATE task_runs SET status='running',claim_token=$2,started_at=$3,deadline_at=$4,provider_scope_kind=$5,provider_scope_id=$6,connection_id=$7,connection_revision=$8,protocol=$9,model_id=$10 WHERE id=$1 AND status='queued' RETURNING id",
        [
          task.id,
          claimToken,
          startedAt,
          deadlineAt,
          provider.scope.kind,
          provider.scope.id,
          provider.connectionId,
          provider.revision,
          provider.protocol,
          provider.modelId,
        ],
      );
      if (!claimed.rows.length) return { handled: false };
      await connection.query("UPDATE tasks SET status='running' WHERE id=$1", [task.task_id]);
      await persistRunMemoryReferences(connection, memory, this.now);
      await this.audit(connection, task, 'task.running', {
        protocol: provider.protocol,
        modelId: provider.modelId,
        connectionId: provider.connectionId,
        connectionRevision: provider.revision,
      });
      await appendRunningRunState(connection, task.id, this.now);
      return {
        handled: true,
        claim: {
          runId: task.id,
          taskId: task.task_id,
          claimToken,
          deadlineAt,
          provider,
          messages,
          maxTotalTokens: target.configuration.limits.maxTotalTokens,
        },
      };
    });
  }
  async publishDelta(claim: TaskClaim, text: string): Promise<void> {
    await this.transaction(async (connection) => {
      const task = await this.candidate(connection, claim.runId);
      if (!task) throw new TaskPublicationError('worker_stopped');
      await this.lockStructure(connection, task);
      try {
        const target = await admitTaskTarget(
          connection,
          this.access(task),
          task.group_grant_id,
          this.now,
          task.bot_version_id,
        );
        const run = await this.lockRun(connection, task);
        if (run?.status !== 'running' || run.claim_token !== claim.claimToken)
          throw new TaskPublicationError('worker_stopped');
        const binding = target.configuration.modelBinding;
        await admitUsableModel(
          connection,
          { actorUserId: task.execution_user_id, scope: binding.scope },
          { connectionId: binding.connectionId, expectedModelId: binding.modelId },
        );
        await assertRunMemoryReferencesCurrent(connection, task.id, this.now);
        if (
          !(await appendAssistantDelta(
            connection,
            { runId: task.id, claimToken: claim.claimToken, text },
            this.now,
          ))
        )
          throw new TaskPublicationError('execution_timeout');
      } catch (error) {
        if (error instanceof TaskPartialOutputLimitError)
          throw new TaskPublicationError('output_limit');
        const code = admissionFailure(error);
        if (code) throw new TaskPublicationError(code);
        throw error;
      }
    });
  }
  async finish(
    claim: TaskClaim,
    outcome: { body: string; usage: Usage | null } | { error: TaskFailure; usage: Usage | null },
  ): Promise<boolean> {
    try {
      return await this.finishTransaction(claim, outcome);
    } catch (error) {
      if (!(error instanceof PublicationDeadlineElapsed)) throw error;
      // The attempted output, audit, completed state and delivery sequence have
      // all rolled back. Fail the same claim under fresh admission; this creates
      // no retry, no new Run and no second provider request.
      return this.finishTransaction(claim, { error: 'execution_timeout', usage: outcome.usage });
    }
  }
  private finishTransaction(
    claim: TaskClaim,
    outcome: { body: string; usage: Usage | null } | { error: TaskFailure; usage: Usage | null },
  ) {
    return this.transaction(async (connection) => {
      const task = await this.candidate(connection, claim.runId);
      if (!task) return false;
      await this.lockStructure(connection, task);
      let denied: TaskFailure | undefined;
      let target: Awaited<ReturnType<typeof admitTaskTarget>> | undefined;
      try {
        target = await admitTaskTarget(
          connection,
          this.access(task),
          task.group_grant_id,
          this.now,
          task.bot_version_id,
        );
      } catch (error) {
        denied = admissionFailure(error);
        if (!denied) throw error;
      }
      const run = await this.lockRun(connection, task);
      if (run?.status !== 'running' || run.claim_token !== claim.claimToken) return false;
      if (target && !denied) {
        try {
          const binding = target.configuration.modelBinding;
          await admitUsableModel(
            connection,
            { actorUserId: task.execution_user_id, scope: binding.scope },
            { connectionId: binding.connectionId, expectedModelId: binding.modelId },
          );
          await assertRunMemoryReferencesCurrent(connection, task.id, this.now);
        } catch (error) {
          denied = admissionFailure(error);
          if (!denied) throw error;
        }
      }
      const failure =
        denied ??
        (run.deadline_at && run.deadline_at.getTime() <= this.now().getTime()
          ? 'execution_timeout'
          : undefined) ??
        ('error' in outcome ? outcome.error : undefined);
      if (failure) {
        await this.fail(connection, task, failure, outcome.usage);
        return true;
      }
      if (!('body' in outcome)) return false;
      const output = await appendBotResult(
        connection,
        { runId: task.id, claimToken: claim.claimToken, body: outcome.body },
        this.now,
      );
      if (!output) {
        await this.fail(connection, task, 'execution_timeout', outcome.usage);
        return true;
      }
      await connection.query(
        "UPDATE task_runs SET status='completed',finished_at=$2,input_tokens=$3,output_tokens=$4,output_event_id=$5 WHERE id=$1",
        [
          task.id,
          this.now(),
          outcome.usage?.inputTokens ?? null,
          outcome.usage?.outputTokens ?? null,
          output.eventId,
        ],
      );
      await connection.query("UPDATE tasks SET status='completed' WHERE id=$1", [task.task_id]);
      await connection.query('DELETE FROM task_run_partial_outputs WHERE run_id=$1', [task.id]);
      await this.audit(connection, task, 'task.completed', { outputEventId: output.eventId });
      await appendCompletedRunState(connection, task.id, this.now);
      if (!run.deadline_at || run.deadline_at.getTime() <= this.now().getTime())
        throw new PublicationDeadlineElapsed();
      return true;
    });
  }
}

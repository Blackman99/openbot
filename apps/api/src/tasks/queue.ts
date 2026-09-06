import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { ConversationAccessError } from '../conversations/service.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { BotAccessError, type BotBinding, type BotConfiguration } from '../bots/service.js';
import { ProviderError } from '../providers/url-policy.js';
import { admitExecutionModel, admitUsableModel } from '../providers/postgres-model-admission.js';
import type { ModelFailure, ModelInput } from '../providers/model-events.js';
import type { ObjectStore } from '../objects/store.js';
import {
  connectionSupportsVision,
  selectAuthorizedImageAttachments,
  selectCurrentTurnImageMessage,
  withImages,
} from './vision-context.js';
import { currentPage } from '../conversations/projection.js';
import {
  loadAttemptChain,
  readPlannedBinding,
  readPlannedNotBefore,
  writeNextAttempt,
} from './next-attempt.js';
import { loadRunContinuation, wireContinuation } from './continuation.js';
import { RECOVERY_CANDIDATE_LIMIT, leaseExpiry } from './lease.js';
import { planWorkerRecovery } from './recovery.js';
import {
  effectiveRetryPolicy,
  planNextAttempt,
  versionListsBinding,
  type NextAttemptPlan,
} from './retry-schedule.js';
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
import { applyTaskExecutionLimits } from './execution-limit-enforcement.js';
import {
  selectRunMemoryContribution,
  persistRunMemoryReferences,
  assertRunMemoryReferencesCurrent,
  MemoryContextLimitError,
  type RunMemoryContribution,
} from '../memories/run-context.js';
import {
  selectRunKnowledgeContribution,
  persistRunKnowledgeReferences,
  assertRunKnowledgeReferencesCurrent,
  KnowledgeContextLimitError,
  type RunKnowledgeContribution,
} from '../knowledge/run-context.js';
import {
  enqueueMemoryExtractionJob,
  persistRunSourceManifest,
} from '../memories/extraction-jobs.js';
import {
  assembleRunContext,
  CONTEXT_BUDGET_BYTES,
  type ContextItem,
} from '../retrieval/assemble.js';

export type TaskFailure =
  | 'execution_forbidden'
  | 'model_unavailable'
  | 'provider_failed'
  | 'execution_timeout'
  | 'output_limit'
  | 'context_limit'
  | 'worker_stopped'
  | 'worker_interrupted';
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
type LockedRun = {
  status: string;
  claim_token: string | null;
  deadline_at: Date | null;
  connection_id: string | null;
  model_id: string | null;
  provider_scope_kind: 'personal' | 'workspace' | null;
  provider_scope_id: string | null;
};
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
  group_id: string | null;
  trigger_sequence: string | number;
  trigger_message_id: string;
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
function uniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
function admissionFailure(error: unknown): TaskFailure | undefined {
  if (
    error instanceof ConversationAccessError ||
    error instanceof GroupBotAccessError ||
    error instanceof BotAccessError
  )
    return 'execution_forbidden';
  if (error instanceof ProviderError) return 'model_unavailable';
  if (
    error instanceof ContextLimitError ||
    error instanceof MemoryContextLimitError ||
    error instanceof KnowledgeContextLimitError
  )
    return 'context_limit';
  return undefined;
}
export class TaskQueue {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
    private readonly objects?: ObjectStore,
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
    const rows = (
      await connection.query<Candidate>(
        `SELECT r.id,r.attempt,r.task_id,t.workspace_id,t.conversation_id,t.execution_user_id,t.bot_id,t.bot_version_id,t.group_grant_id,c.group_id,e.sequence AS trigger_sequence,e.message_id AS trigger_message_id FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id JOIN conversation_events e ON e.id=t.trigger_event_id
       WHERE ${runId ? 'r.id=$1' : "r.status='queued' AND t.status='queued'"} ORDER BY r.created_at,r.id`,
        runId ? [runId] : [],
      )
    ).rows;
    if (runId) return rows[0];
    const due = this.now().getTime();
    for (const row of rows) {
      const notBefore = await readPlannedNotBefore(connection, row.id);
      if (!notBefore || notBefore.getTime() <= due) return row;
    }
  }
  private async lockRun(connection: SqlConnection, task: Candidate) {
    if (!(await lockTaskAncestry(connection, task.task_id))) return undefined;
    return (
      await connection.query<LockedRun>(
        'SELECT r.status,r.claim_token,r.deadline_at,r.connection_id,r.model_id,r.provider_scope_kind,r.provider_scope_id FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.task_id=$2 AND r.status=t.status AND r.attempt=(SELECT MAX(attempt) FROM task_runs WHERE task_id=$2) FOR UPDATE',
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
  private limitAccess(task: Candidate) {
    return {
      taskId: task.task_id,
      workspaceId: task.workspace_id,
      conversationId: task.conversation_id,
      executionUserId: task.execution_user_id,
      now: this.now(),
    };
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
    await applyTaskExecutionLimits(connection, this.limitAccess(task), { holdIfHard: true });
  }
  private async failIfRunning(
    connection: SqlConnection,
    task: Candidate,
    error: TaskFailure,
    usage: Usage | null = null,
  ) {
    const marked = await connection.query<{ id: string }>(
      `UPDATE task_runs SET status='failed',finished_at=$2,error_code=$3,input_tokens=$4,output_tokens=$5
       WHERE id=$1 AND status='running' RETURNING id`,
      [task.id, this.now(), error, usage?.inputTokens ?? null, usage?.outputTokens ?? null],
    );
    if (!marked.rows.length) return false;
    await connection.query("UPDATE tasks SET status='failed' WHERE id=$1 AND status='running'", [
      task.task_id,
    ]);
    await this.audit(connection, task, 'task.failed', { error });
    await appendFailedRunState(connection, task.id, this.now);
    await applyTaskExecutionLimits(connection, this.limitAccess(task), { holdIfHard: true });
    return true;
  }
  async isClaimActive(claim: TaskClaim): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      return (
        (
          await connection.query(
            `SELECT r.id FROM task_runs r JOIN tasks t ON t.id=r.task_id
           JOIN task_run_leases l ON l.run_id=$1 AND l.claim_token=$3 AND l.expires_at>$4
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
      if (
        (await applyTaskExecutionLimits(connection, this.limitAccess(task), { holdIfHard: true }))
          .hard
      )
        return { handled: true };
      let provider: TaskClaim['provider'];
      let memory: RunMemoryContribution;
      let knowledge: RunKnowledgeContribution;
      let selectedMessages: Array<{
        id: string;
        creationSequence: number;
        versionEventId: string;
        role: 'user' | 'assistant';
      }> = [];
      let messages: ModelInput['messages'] = [
        { role: 'system', content: target.configuration.instructions },
      ];
      try {
        memory = await selectRunMemoryContribution(connection, task.id, this.now);
        knowledge = await selectRunKnowledgeContribution(connection, task.id, this.now);
        const items: ContextItem[] = [
          {
            kind: 'system',
            id: 'system',
            role: 'system',
            content: target.configuration.instructions,
          },
        ];
        for (const [index, message] of memory.messages.entries())
          items.push({
            kind: 'memory',
            id: `memory-${index}`,
            role: 'user',
            content: message.content,
            ...memoryItemProvenance(message.content, memory, task),
          });
        if (knowledge.messages[0])
          items.push({
            kind: 'knowledge',
            id: 'knowledge',
            role: 'user',
            content: knowledge.messages[0].content,
            ...knowledgeItemProvenance(knowledge, task),
          });
        const ledger: typeof selectedMessages = [];
        let after = target.lowerBound - 1,
          scanned = memory.itemCount + knowledge.itemCount;
        if (scanned > 1000) throw new ContextLimitError();
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
            scanned++;
            if (scanned > 1000) throw new ContextLimitError();
            if (!message.deleted && message.body) {
              const role = 'kind' in message.author ? 'assistant' : 'user';
              ledger.push({
                id: message.id,
                creationSequence: message.creationSequence,
                versionEventId: message.versionEventId,
                role,
              });
              items.push({
                kind: 'ledger',
                id: message.id,
                role,
                content: message.body,
                sourceId: message.versionEventId,
                version: message.version,
                locator: `sequence:${message.creationSequence}`,
              });
            }
          }
          if (!page.hasMore) break;
          after = page.messages.at(-1)!.creationSequence;
        }
        const assembled = assembleRunContext(items);
        if (assembled.bytes > CONTEXT_BUDGET_BYTES) throw new ContextLimitError();
        const kept = new Set(assembled.items.map((item) => item.id));
        const keptKinds = new Set(assembled.items.map((item) => item.kind));
        messages = [...assembled.messages];
        selectedMessages = ledger.filter((message) => kept.has(message.id));
        memory = keptMemoryContribution(memory, assembled.items);
        knowledge = keptKinds.has('knowledge')
          ? knowledge
          : {
              ...knowledge,
              messages: Object.freeze([]),
              references: Object.freeze([]),
              itemCount: 0,
              bytes: 0,
            };
        const binding = await this.selectedBinding(connection, task.id, target.configuration);
        provider = await admitExecutionModel(
          connection,
          { actorUserId: task.execution_user_id, scope: binding.scope },
          { connectionId: binding.connectionId, expectedModelId: binding.modelId },
        );
        const vision = await connectionSupportsVision(
          connection,
          { actorUserId: task.execution_user_id, scope: provider.scope },
          provider.connectionId,
        );
        const imageMessageId = await selectCurrentTurnImageMessage(connection, {
          conversationId: task.conversation_id,
          triggerMessageId: task.trigger_message_id,
          triggerSequence: task.trigger_sequence,
        });
        const currentImages = await this.loadAuthorizedImages(connection, {
          workspaceId: task.workspace_id,
          conversationId: task.conversation_id,
          messageId: imageMessageId,
        });
        if (currentImages.length && !vision) throw new ProviderError('model_capability_required');
        const knowledgeImages =
          vision && knowledge.messages[0]
            ? await this.loadKnowledgeImages(connection, knowledge.messages[0].content)
            : [];
        messages = assembled.items.map((item, index) => {
          const message = messages[index] ?? assembled.messages[index]!;
          if (item.kind === 'ledger' && item.id === imageMessageId && currentImages.length)
            return withImages(message, currentImages);
          if (item.kind === 'knowledge' && knowledgeImages.length)
            return withImages(message, knowledgeImages);
          return message;
        });
        if (
          currentImages.length &&
          vision &&
          !assembled.items.some((item) => item.id === imageMessageId)
        )
          messages.push(withImages({ role: 'user', content: '' }, currentImages));
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
      await connection.query(
        'INSERT INTO task_run_leases(run_id,claim_token,heartbeat_at,expires_at,created_at) VALUES($1,$2,$3,$4,$3)',
        [task.id, claimToken, startedAt, leaseExpiry(startedAt, deadlineAt)],
      );
      await connection.query("UPDATE tasks SET status='running' WHERE id=$1", [task.task_id]);
      await persistRunMemoryReferences(connection, memory, this.now);
      await persistRunKnowledgeReferences(connection, knowledge, this.now);
      await persistRunSourceManifest(connection, {
        runId: task.id,
        workspaceId: task.workspace_id,
        conversationId: task.conversation_id,
        botVersionId: task.bot_version_id,
        memory,
        messages: selectedMessages,
        now: this.now(),
      });
      const scheduled = await loadRunContinuation(connection, {
        id: task.id,
        protocol: provider.protocol,
        modelId: provider.modelId,
      });
      await this.audit(connection, task, 'task.running', {
        protocol: provider.protocol,
        modelId: provider.modelId,
        connectionId: provider.connectionId,
        connectionRevision: provider.revision,
        ...(scheduled ? { continuation: wireContinuation(scheduled) } : {}),
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
        if (!(await this.liveLease(connection, claim))) {
          if (run.deadline_at && run.deadline_at.getTime() <= this.now().getTime())
            throw new TaskPublicationError('execution_timeout');
          throw new TaskPublicationError('worker_stopped');
        }
        const binding = runBinding(run, target.configuration.modelBinding);
        await admitUsableModel(
          connection,
          { actorUserId: task.execution_user_id, scope: binding.scope },
          { connectionId: binding.connectionId, expectedModelId: binding.modelId },
        );
        await assertRunMemoryReferencesCurrent(connection, task.id, this.now);
        await assertRunKnowledgeReferencesCurrent(connection, task.id, this.now);
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
    outcome:
      | { body: string; usage: Usage | null }
      | { error: TaskFailure; usage: Usage | null; modelFailure?: ModelFailure },
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
    outcome:
      | { body: string; usage: Usage | null }
      | { error: TaskFailure; usage: Usage | null; modelFailure?: ModelFailure },
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
      const deadlineElapsed = Boolean(
        run.deadline_at && run.deadline_at.getTime() <= this.now().getTime(),
      );
      if (
        !(await this.liveLease(connection, claim)) &&
        !deadlineElapsed &&
        !('error' in outcome && outcome.error === 'execution_timeout')
      )
        return false;
      if (target && !denied) {
        try {
          const binding = runBinding(run, target.configuration.modelBinding);
          await admitUsableModel(
            connection,
            { actorUserId: task.execution_user_id, scope: binding.scope },
            { connectionId: binding.connectionId, expectedModelId: binding.modelId },
          );
          await assertRunMemoryReferencesCurrent(connection, task.id, this.now);
          await assertRunKnowledgeReferencesCurrent(connection, task.id, this.now);
        } catch (error) {
          denied = admissionFailure(error);
          if (!denied) throw error;
        }
      }
      const failure =
        denied ??
        (deadlineElapsed ? 'execution_timeout' : undefined) ??
        ('error' in outcome ? outcome.error : undefined);
      if (failure) {
        await this.fail(connection, task, failure, outcome.usage);
        if (failure === 'provider_failed' && !denied && target && 'modelFailure' in outcome)
          await this.continueAfterTransientFailure(
            connection,
            task,
            target.configuration,
            outcome.modelFailure,
            claim,
          );
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
      await applyTaskExecutionLimits(connection, this.limitAccess(task), { holdIfHard: false });
      const digest = (
        await connection.query<{ digest: string }>(
          'SELECT digest FROM run_source_manifests WHERE run_id=$1',
          [task.id],
        )
      ).rows[0]?.digest;
      if (!digest) throw new Error('completed Run is missing its source manifest');
      await enqueueMemoryExtractionJob(connection, {
        runId: task.id,
        outputEventId: output.eventId,
        digest,
        now: this.now(),
      });
      if (!run.deadline_at || run.deadline_at.getTime() <= this.now().getTime())
        throw new PublicationDeadlineElapsed();
      return true;
    });
  }
  async renewClaimLease(claim: TaskClaim): Promise<boolean> {
    return this.transaction(async (connection) => {
      const run = (
        await connection.query<LockedRun>(
          `SELECT r.status,r.claim_token,r.deadline_at,r.connection_id,r.model_id,r.provider_scope_kind,r.provider_scope_id
           FROM task_runs r JOIN tasks t ON t.id=r.task_id
           WHERE r.id=$1 AND r.task_id=$2 AND r.claim_token=$3
             AND r.status='running' AND t.status='running'
             AND r.attempt=(SELECT MAX(attempt) FROM task_runs WHERE task_id=$2)
           FOR UPDATE`,
          [claim.runId, claim.taskId, claim.claimToken],
        )
      ).rows[0];
      if (!run) return false;
      if (!(await taskAncestryIsActive(connection, claim.taskId))) return false;
      const lease = (
        await connection.query<{ expires_at: Date }>(
          'SELECT expires_at FROM task_run_leases WHERE run_id=$1 AND claim_token=$2 FOR UPDATE',
          [claim.runId, claim.claimToken],
        )
      ).rows[0];
      const now = this.now();
      if (!lease || lease.expires_at.getTime() <= now.getTime()) return false;
      if (run.deadline_at && run.deadline_at.getTime() <= now.getTime()) return false;
      const renewed = await connection.query<{ run_id: string }>(
        `UPDATE task_run_leases SET heartbeat_at=$2,expires_at=$3
         WHERE run_id=$1 AND claim_token=$4 AND expires_at>$2 RETURNING run_id`,
        [claim.runId, now, leaseExpiry(now, run.deadline_at ?? claim.deadlineAt), claim.claimToken],
      );
      return renewed.rows.length === 1;
    });
  }
  async recoverExpiredClaims(): Promise<number> {
    const ids = await this.expiredRecoveryRunIds();
    let recovered = 0;
    for (const runId of ids) {
      if (await this.recoverExpiredRun(runId)) recovered++;
    }
    return recovered;
  }
  private async expiredRecoveryRunIds(): Promise<string[]> {
    const connection = await this.pool.connect();
    try {
      return (
        await connection.query<{ id: string }>(
          `SELECT r.id FROM task_runs r
           JOIN tasks t ON t.id=r.task_id AND r.status=t.status
           JOIN task_run_leases l ON l.run_id=r.id AND l.claim_token=r.claim_token
           WHERE r.status='running' AND l.expires_at<=$1
           ORDER BY l.expires_at,r.id
           LIMIT $2`,
          [this.now(), RECOVERY_CANDIDATE_LIMIT],
        )
      ).rows.map((row) => row.id);
    } finally {
      connection.release();
    }
  }
  private async recoverExpiredRun(runId: string): Promise<boolean> {
    try {
      return await this.recoverExpiredRunOnce(runId);
    } catch (error) {
      if (uniqueViolation(error)) return false;
      throw error;
    }
  }
  private async recoverExpiredRunOnce(runId: string): Promise<boolean> {
    return this.transaction(async (connection) => {
      const task = await this.candidate(connection, runId);
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
      if (run?.status !== 'running' || !run.claim_token) return false;
      const lease = (
        await connection.query<{ claim_token: string; expires_at: Date }>(
          'SELECT claim_token,expires_at FROM task_run_leases WHERE run_id=$1 FOR UPDATE',
          [runId],
        )
      ).rows[0];
      const now = this.now();
      if (
        !lease ||
        lease.claim_token !== run.claim_token ||
        lease.expires_at.getTime() > now.getTime()
      )
        return false;
      const existing = (
        await connection.query(
          'SELECT source_run_id FROM task_run_recovery_receipts WHERE source_run_id=$1',
          [runId],
        )
      ).rows[0];
      if (existing) return false;
      if (run.deadline_at && run.deadline_at.getTime() <= now.getTime()) {
        if (!(await this.failIfRunning(connection, task, 'execution_timeout'))) return false;
        await this.insertRecoveryReceipt(connection, {
          sourceRunId: runId,
          taskId: task.task_id,
          chainRootRunId: runId,
          decision: 'stopped',
          stopReason: 'execution_timeout',
          now,
        });
        return true;
      }
      if (!(await this.failIfRunning(connection, task, 'worker_interrupted'))) return false;
      if (denied) {
        await this.insertRecoveryReceipt(connection, {
          sourceRunId: runId,
          taskId: task.task_id,
          chainRootRunId: runId,
          decision: 'stopped',
          stopReason: denied,
          now,
        });
        return true;
      }
      const chain = await loadAttemptChain(connection, task.task_id, task.id);
      if (chain.attempts.some((attempt) => attempt.origin === 'worker_recovery')) {
        await this.insertRecoveryReceipt(connection, {
          sourceRunId: runId,
          taskId: task.task_id,
          chainRootRunId: chain.rootRunId,
          decision: 'stopped',
          stopReason: 'recovery_exhausted',
          now,
        });
        return true;
      }
      const binding = runBinding(run, target!.configuration.modelBinding);
      try {
        await admitUsableModel(
          connection,
          { actorUserId: task.execution_user_id, scope: binding.scope },
          { connectionId: binding.connectionId, expectedModelId: binding.modelId },
        );
      } catch (error) {
        const code = admissionFailure(error);
        if (!code) throw error;
        await this.insertRecoveryReceipt(connection, {
          sourceRunId: runId,
          taskId: task.task_id,
          chainRootRunId: chain.rootRunId,
          decision: 'stopped',
          stopReason: code,
          now,
        });
        return true;
      }
      const policy = effectiveRetryPolicy(target!.configuration.retryPolicy);
      if (chain.attempts.length >= policy.maxRunsPerChain) {
        await this.insertRecoveryReceipt(connection, {
          sourceRunId: runId,
          taskId: task.task_id,
          chainRootRunId: chain.rootRunId,
          decision: 'stopped',
          stopReason: 'budget_exhausted',
          now,
        });
        return true;
      }
      const written = await writeNextAttempt(
        connection,
        this.nextAttemptInput(
          task,
          planWorkerRecovery({
            binding,
            sourceRunId: task.id,
            chainRootRunId: chain.rootRunId,
            chainAttemptOrdinal: chain.attempts.length + 1,
            chainLimitSnapshot: policy.maxRunsPerChain,
            now,
          }),
        ),
      );
      if (!written.scheduled) {
        await this.insertRecoveryReceipt(connection, {
          sourceRunId: runId,
          taskId: task.task_id,
          chainRootRunId: chain.rootRunId,
          decision: 'stopped',
          stopReason:
            written.reason === 'cancelled'
              ? 'cancelled'
              : written.reason === 'budget'
                ? 'budget'
                : 'duplicate',
          now,
        });
        return true;
      }
      await this.insertRecoveryReceipt(connection, {
        sourceRunId: runId,
        taskId: task.task_id,
        chainRootRunId: chain.rootRunId,
        decision: 'queued_successor',
        successorRunId: written.runId,
        now,
      });
      return true;
    });
  }
  private async insertRecoveryReceipt(
    connection: SqlConnection,
    input: {
      sourceRunId: string;
      taskId: string;
      chainRootRunId: string;
      decision: 'queued_successor' | 'stopped';
      successorRunId?: string;
      stopReason?: string;
      now: Date;
    },
  ) {
    await connection.query(
      `INSERT INTO task_run_recovery_receipts(
        source_run_id,task_id,chain_root_run_id,interrupted_at,decision,successor_run_id,stop_reason,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.sourceRunId,
        input.taskId,
        input.chainRootRunId,
        input.now,
        input.decision,
        input.successorRunId ?? null,
        input.stopReason ?? null,
        input.now,
      ],
    );
  }
  private async liveLease(connection: SqlConnection, claim: TaskClaim): Promise<boolean> {
    const lease = (
      await connection.query<{ expires_at: Date }>(
        'SELECT expires_at FROM task_run_leases WHERE run_id=$1 AND claim_token=$2',
        [claim.runId, claim.claimToken],
      )
    ).rows[0];
    return Boolean(lease && lease.expires_at.getTime() > this.now().getTime());
  }
  private async selectedBinding(
    connection: SqlConnection,
    runId: string,
    configuration: BotConfiguration,
  ): Promise<BotBinding> {
    const planned = await readPlannedBinding(connection, runId);
    if (!planned) return configuration.modelBinding;
    if (!versionListsBinding(configuration, planned))
      throw new ProviderError('model_binding_changed');
    return planned;
  }
  private async continueAfterTransientFailure(
    connection: SqlConnection,
    task: Candidate,
    configuration: BotConfiguration,
    failure: ModelFailure | undefined,
    claim: TaskClaim,
  ) {
    const chain = await loadAttemptChain(connection, task.task_id, task.id);
    const last = chain.attempts.at(-1);
    if (last?.runId === task.id) {
      last.connectionId = claim.provider.connectionId;
      last.modelId = claim.provider.modelId;
    } else if (!chain.attempts.some((attempt) => attempt.runId === task.id))
      chain.attempts.push({
        runId: task.id,
        connectionId: claim.provider.connectionId,
        modelId: claim.provider.modelId,
        origin: chain.attempts.length ? 'provider_retry' : 'initial',
      });
    if (!failure) return;
    const plan = planNextAttempt({
      failure,
      configuration,
      chain,
      now: this.now(),
    });
    if (!plan) return;
    try {
      await connection.query('SAVEPOINT col10_next_attempt');
    } catch {
      await writeNextAttempt(connection, this.nextAttemptInput(task, plan));
      return;
    }
    try {
      await writeNextAttempt(connection, this.nextAttemptInput(task, plan));
      await connection.query('RELEASE SAVEPOINT col10_next_attempt');
    } catch {
      await connection.query('ROLLBACK TO SAVEPOINT col10_next_attempt');
    }
  }
  private nextAttemptInput(task: Candidate, plan: NextAttemptPlan) {
    return {
      taskId: task.task_id,
      sourceRunId: task.id,
      workspaceId: task.workspace_id,
      conversationId: task.conversation_id,
      executionUserId: task.execution_user_id,
      sourceAttempt: task.attempt,
      plan,
      now: this.now(),
    };
  }
  private async loadAuthorizedImages(
    connection: SqlConnection,
    filter: { workspaceId: string; conversationId: string; messageId: string },
  ) {
    const rows = await selectAuthorizedImageAttachments(connection, filter);
    if (!rows.length) return [];
    if (!this.objects) throw new ProviderError('model_capability_required');
    const images = [];
    for (const row of rows) {
      const bytes = await this.objects.read(
        { workspaceId: row.workspaceId, objectId: row.storageId },
        row.bytes,
      );
      if (
        bytes.length !== row.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== row.sha256
      )
        throw new ProviderError('model_capability_required');
      images.push({ mediaType: row.mediaType, bytes });
    }
    return images;
  }
  private async loadKnowledgeImages(connection: SqlConnection, content: string) {
    let chunks: Array<{
      mediaType?: string;
      source?: { workspaceId?: string; conversationId?: string; messageId?: string };
    }> = [];
    try {
      chunks = (JSON.parse(content) as { chunks?: typeof chunks }).chunks ?? [];
    } catch {
      return [];
    }
    const images = [];
    const seen = new Set<string>();
    for (const chunk of chunks) {
      const workspaceId = chunk.source?.workspaceId;
      const conversationId = chunk.source?.conversationId;
      const messageId = chunk.source?.messageId;
      if (
        !workspaceId ||
        !conversationId ||
        !messageId ||
        seen.has(messageId) ||
        (chunk.mediaType !== 'image/png' && chunk.mediaType !== 'image/jpeg')
      )
        continue;
      seen.add(messageId);
      images.push(
        ...(await this.loadAuthorizedImages(connection, {
          workspaceId,
          conversationId,
          messageId,
        })),
      );
    }
    return images;
  }
}

type MemoryKind = RunMemoryContribution['references'][number]['kind'];

function memoryMessageKind(content: string): MemoryKind | undefined {
  try {
    const kind = (JSON.parse(content) as { kind?: string }).kind;
    if (kind === 'group_memories') return 'group';
    if (kind === 'bot_private_memories') return 'bot-private';
    if (kind === 'approved_facts') return 'approved-fact';
  } catch {
    return undefined;
  }
}

function memoryItemProvenance(
  content: string,
  contribution: RunMemoryContribution,
  task: Candidate,
): Pick<ContextItem, 'sourceId' | 'scope' | 'version' | 'locator'> {
  const kind = memoryMessageKind(content);
  const reference = contribution.references.find((item) => item.kind === kind);
  let version: number | undefined;
  try {
    const first = (JSON.parse(content) as { memories?: Array<{ version?: number }> }).memories?.[0];
    if (typeof first?.version === 'number') version = first.version;
  } catch {
    version = undefined;
  }
  if (reference?.kind === 'group')
    return {
      sourceId: reference.sourceEventId,
      locator: reference.sourceEventId,
      ...(task.group_id ? { scope: `group:${task.group_id}` } : {}),
      ...(version !== undefined ? { version } : {}),
    };
  if (reference?.kind === 'bot-private')
    return {
      sourceId: reference.sourceEventId,
      locator: reference.sourceEventId,
      scope: `bot:${task.bot_id}`,
      ...(version !== undefined ? { version } : {}),
    };
  if (reference?.kind === 'approved-fact')
    return {
      sourceId: reference.factId,
      locator: reference.versionId,
      scope: `fact:${reference.factId}`,
      ...(version !== undefined ? { version } : {}),
    };
  return version !== undefined ? { version } : {};
}

function knowledgeItemProvenance(
  contribution: RunKnowledgeContribution,
  task: Candidate,
): Pick<ContextItem, 'sourceId' | 'scope' | 'version' | 'locator'> {
  const reference = contribution.references[0];
  if (!reference) return {};
  let version: number | undefined;
  let locator = reference.chunkId;
  try {
    const chunk = (
      JSON.parse(contribution.messages[0]!.content) as {
        chunks?: Array<{
          fileVersion?: number;
          locator?: { kind?: string; start?: number; end?: number };
        }>;
      }
    ).chunks?.[0];
    if (typeof chunk?.fileVersion === 'number') version = chunk.fileVersion;
    if (
      chunk?.locator?.kind &&
      chunk.locator.start !== undefined &&
      chunk.locator.end !== undefined
    )
      locator = `${chunk.locator.kind}:${chunk.locator.start}-${chunk.locator.end}`;
  } catch {
    locator = reference.chunkId;
  }
  return {
    sourceId: reference.documentId,
    locator,
    scope: `bot:${task.bot_id}`,
    ...(version !== undefined ? { version } : {}),
  };
}

function keptMemoryContribution(
  contribution: RunMemoryContribution,
  items: readonly ContextItem[],
): RunMemoryContribution {
  const kept = items.filter((item) => item.kind === 'memory');
  if (!kept.length)
    return {
      ...contribution,
      messages: Object.freeze([]),
      references: Object.freeze([]),
      itemCount: 0,
      bytes: 0,
    };
  if (kept.length === contribution.messages.length) return contribution;
  const contents = new Set(kept.map((item) => item.content));
  const messages = contribution.messages.filter((message) => contents.has(message.content));
  const kinds = new Set(
    messages
      .map((message) => memoryMessageKind(message.content))
      .filter((kind) => kind !== undefined),
  );
  const references = contribution.references.filter((reference) => kinds.has(reference.kind));
  return {
    ...contribution,
    messages: Object.freeze(messages),
    references: Object.freeze(references),
    itemCount: references.length,
    bytes: messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0),
  };
}

function runBinding(run: LockedRun, fallback: BotBinding): BotBinding {
  if (
    run.connection_id &&
    run.model_id &&
    (run.provider_scope_kind === 'personal' || run.provider_scope_kind === 'workspace') &&
    run.provider_scope_id
  )
    return {
      scope: { kind: run.provider_scope_kind, id: run.provider_scope_id },
      connectionId: run.connection_id,
      modelId: run.model_id,
    };
  return fallback;
}

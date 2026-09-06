import type { SqlPool } from '../auth/postgres-auth-repository.js';
import type { ModelAdapter, ProviderProtocol } from '../providers/model-events.js';
import type { ProviderSecretBox } from '../providers/secrets.js';
import { withAbort } from '../providers/transport.js';
import type { ObjectStore } from '../objects/store.js';
import { CLAIM_HEARTBEAT_MS } from './lease.js';
import { TaskQueue, TaskPublicationError, type TaskFailure, type Usage } from './queue.js';
import { TaskDeltaPublication } from './delta-publication.js';
import type { ModelEvent, ModelFailure } from '../providers/model-events.js';
import { ExtractionWorker } from '../memories/extraction-worker.js';
import { RoutineExecutor } from '../routines/executor.js';
import { parseDelegateAction } from './delegate-action.js';
import { parseHandoffAction } from './handoff-action.js';
import { parseRequestApprovalAction, parseRequestInputAction } from './human-request-action.js';
import { botRoutineCollaborationDenial } from '../routines/bot-actions.js';

export interface TaskWorkerOptions {
  secrets: ProviderSecretBox;
  createAdapter: (protocol: ProviderProtocol, options: { timeoutMs: number }) => ModelAdapter;
  objects?: ObjectStore;
}
export class TaskWorker {
  private readonly queue: TaskQueue;
  private readonly extraction: ExtractionWorker;
  private readonly routines: RoutineExecutor;
  constructor(
    pool: SqlPool,
    private readonly options: TaskWorkerOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.queue = new TaskQueue(pool, now, options.objects);
    this.extraction = new ExtractionWorker(pool, now);
    this.routines = new RoutineExecutor(pool, now);
  }
  async runOnce(signal?: AbortSignal): Promise<boolean> {
    let scheduled = false;
    // Fire due one-time routines before claiming generation work so a restart
    // at trigger time recovers the occurrence without waiting on a busy queue.
    while (!signal?.aborted && (await this.routines.runOnce()).handled) scheduled = true;
    const handled = await this.runTaskOnce(signal);
    let extracted = false;
    // Drain every due extraction job on this tick. A just-completed Run enqueues
    // its job at finish; older leftover jobs must not hide that work from an
    // immediately following idle poll, and must not start a new generation.
    while (!signal?.aborted && (await this.extraction.runOnce())) extracted = true;
    return scheduled || extracted || handled;
  }
  private async runTaskOnce(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    await this.queue.recoverExpiredClaims();
    const selected = await this.queue.claimNext(),
      claim = selected.claim;
    if (!claim) return selected.handled;
    const timeoutMs = claim.deadlineAt.getTime() - this.now().getTime();
    if (timeoutMs <= 0) {
      await this.queue.finish(claim, { error: 'execution_timeout', usage: null });
      return true;
    }
    const controller = new AbortController(),
      combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const publication = new TaskDeltaPublication(
      (text) => this.queue.publishDelta(claim, text),
      () => controller.abort(),
    );
    let timedOut = false,
      limit = false,
      claimStopped = false,
      observing = true;
    let observation: Promise<void> = Promise.resolve(),
      observationTimer: ReturnType<typeof setTimeout> | undefined;
    // Observe durable state even when a provider emits no callbacks. Each
    // check finishes before scheduling the next; a database failure aborts
    // this request without claiming that cancellation committed.
    const observeClaim = async (): Promise<void> => {
      try {
        const renewed = await this.queue.renewClaimLease(claim);
        claimStopped = !renewed;
        if (renewed) await this.queue.recoverExpiredClaims();
      } catch {
        claimStopped = true;
      }
      if (claimStopped) controller.abort();
      else if (observing && !combined.aborted) {
        observationTimer = setTimeout(() => {
          observation = observeClaim();
        }, CLAIM_HEARTBEAT_MS);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let usage: Usage | null = null,
      body = '',
      bytes = 0;
    const observe = (event: ModelEvent) => {
      if (event.type === 'text') {
        const text = Buffer.from(event.text).toString('utf8');
        body += text;
        bytes += Buffer.byteLength(text);
        if (body.length > 32000 || bytes > 128000) limit = true;
      } else if (event.type === 'usage') {
        if (
          !Number.isSafeInteger(event.inputTokens) ||
          event.inputTokens < 0 ||
          !Number.isSafeInteger(event.outputTokens) ||
          event.outputTokens < 0
        )
          throw new Error('Invalid model usage');
        usage = {
          inputTokens: Math.max(usage?.inputTokens ?? 0, event.inputTokens),
          outputTokens: Math.max(usage?.outputTokens ?? 0, event.outputTokens),
        };
        if (usage.inputTokens + usage.outputTokens > claim.maxTotalTokens) limit = true;
      }
      if (limit) {
        controller.abort();
        throw new Error('Task output limit');
      }
    };
    let failure: TaskFailure | undefined;
    let modelFailure: ModelFailure | undefined;
    try {
      observation = observeClaim();
      await observation;
      combined.throwIfAborted();
      const credentials = this.options.secrets.open(
        claim.provider.sealedCredentials,
        claim.provider.credentialContext,
      );
      const response = await withAbort(
        this.options.createAdapter(claim.provider.protocol, { timeoutMs }).generate(
          {
            ...credentials,
            baseUrl: claim.provider.baseUrl,
            modelId: claim.provider.modelId,
            ...(claim.provider.anthropicVersion
              ? { anthropicVersion: claim.provider.anthropicVersion }
              : {}),
            messages: claim.messages,
            stream: true,
            ...(claim.tools ? { tools: claim.tools } : {}),
            maxOutputTokens: Math.min(32000, claim.maxTotalTokens),
            maxResponseBytes: 8 * 1024 * 1024,
          },
          combined,
          async (event) => {
            combined.throwIfAborted();
            observe(event);
            if (event.type === 'text' && event.text)
              await publication.push(Buffer.from(event.text).toString('utf8'));
          },
        ),
        combined,
      );
      if (response.error) {
        failure = 'provider_failed';
        modelFailure = response.error;
      }
      // Rebuild only the pure accumulator. The callback has already published
      // each delta; terminal response.events must never publish that text again.
      if (!failure) {
        body = '';
        bytes = 0;
        usage = null;
        const actions = response.events.filter((event) => event.type === 'action');
        if (actions.length) {
          const delegates = [];
          const handoffs = [];
          const inputs = [];
          const approvals = [];
          for (const event of actions) {
            const actionId = typeof event.id === 'string' ? event.id : '';
            // ROUT-01 AC6: bots cannot create routines or escalate frequency/budget.
            if (botRoutineCollaborationDenial(event)) {
              delegates.length = 0;
              handoffs.length = 0;
              inputs.length = 0;
              approvals.length = 0;
              break;
            }
            const delegate = parseDelegateAction(event);
            const handoff = parseHandoffAction(event);
            const input = parseRequestInputAction(event);
            const approval = parseRequestApprovalAction(event);
            if (delegate && actionId) delegates.push({ action: delegate, actionId });
            else if (handoff && actionId) handoffs.push(handoff);
            else if (input && actionId) inputs.push(input);
            else if (approval && actionId) approvals.push(approval);
            else {
              delegates.length = 0;
              handoffs.length = 0;
              inputs.length = 0;
              approvals.length = 0;
              break;
            }
          }
          if (
            inputs.length === 1 &&
            !approvals.length &&
            !delegates.length &&
            !handoffs.length &&
            (await this.queue.requestHuman(claim, { kind: 'input', ...inputs[0]! }))
          ) {
            await publication.discard();
            return true;
          }
          if (
            approvals.length === 1 &&
            !inputs.length &&
            !delegates.length &&
            !handoffs.length &&
            (await this.queue.requestHuman(claim, { kind: 'approval', ...approvals[0]! }))
          ) {
            await publication.discard();
            return true;
          }
          if (
            handoffs.length === 1 &&
            !delegates.length &&
            !inputs.length &&
            !approvals.length &&
            (await this.queue.handoff(claim, handoffs[0]!))
          ) {
            await publication.discard();
            return true;
          }
          if (
            delegates.length &&
            !handoffs.length &&
            !inputs.length &&
            !approvals.length &&
            (await this.queue.delegate(claim, delegates))
          ) {
            await publication.discard();
            return true;
          }
          failure = 'provider_failed';
        }
        if (!failure) {
          for (const event of response.events) observe(event);
          if (!body.trim() || !response.events.some((event) => event.type === 'complete'))
            failure = 'provider_failed';
          if (!failure) await publication.flush();
        }
      }
    } catch (error) {
      failure = error instanceof TaskPublicationError ? error.code : 'provider_failed';
    } finally {
      observing = false;
      clearTimeout(observationTimer);
      await observation;
      clearTimeout(timer);
      await publication.discard();
    }
    if (limit) failure = 'output_limit';
    else if (timedOut || this.now().getTime() >= claim.deadlineAt.getTime())
      failure = 'execution_timeout';
    else if (claimStopped || signal?.aborted) failure = 'worker_stopped';
    await this.queue.finish(
      claim,
      failure
        ? {
            error: failure,
            usage,
            ...(failure === 'provider_failed' && modelFailure ? { modelFailure } : {}),
          }
        : { body, usage },
    );
    return true;
  }
}

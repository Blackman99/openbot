import type { SqlPool } from '../auth/postgres-auth-repository.js';
import type { ModelAdapter, ProviderProtocol } from '../providers/model-events.js';
import type { ProviderSecretBox } from '../providers/secrets.js';
import { TaskQueue, type TaskFailure, type Usage } from './queue.js';
import type { ModelEvent } from '../providers/model-events.js';

export interface TaskWorkerOptions {
  secrets: ProviderSecretBox;
  createAdapter: (protocol: ProviderProtocol, options: { timeoutMs: number }) => ModelAdapter;
}
export class TaskWorker {
  private readonly queue: TaskQueue;
  constructor(
    pool: SqlPool,
    private readonly options: TaskWorkerOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.queue = new TaskQueue(pool, now);
  }
  async runOnce(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
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
    let timedOut = false,
      limit = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let usage: Usage | null = null,
      body = '',
      bytes = 0;
    const observe = (event: ModelEvent) => {
      if (event.type === 'text') {
        body += event.text;
        bytes += Buffer.byteLength(event.text);
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
    try {
      combined.throwIfAborted();
      const credentials = this.options.secrets.open(
        claim.provider.sealedCredentials,
        claim.provider.credentialContext,
      );
      const response = await this.options
        .createAdapter(claim.provider.protocol, { timeoutMs })
        .generate(
          {
            ...credentials,
            baseUrl: claim.provider.baseUrl,
            modelId: claim.provider.modelId,
            ...(claim.provider.anthropicVersion
              ? { anthropicVersion: claim.provider.anthropicVersion }
              : {}),
            messages: claim.messages,
            stream: true,
            maxOutputTokens: Math.min(32000, claim.maxTotalTokens),
            maxResponseBytes: 8 * 1024 * 1024,
          },
          combined,
          observe,
        );
      if (response.error) failure = 'provider_failed';
      // Rebuild from the terminal response once; callback snapshots are only
      // early budget checks and never independently authorize publication.
      if (!failure) {
        body = '';
        bytes = 0;
        usage = null;
        for (const event of response.events) {
          if (event.type === 'action') throw new Error('Unexpected model action');
          observe(event);
        }
        if (!body.trim() || !response.events.some((event) => event.type === 'complete'))
          failure = 'provider_failed';
      }
    } catch {
      failure = 'provider_failed';
    } finally {
      clearTimeout(timer);
    }
    if (limit) failure = 'output_limit';
    else if (timedOut || this.now().getTime() >= claim.deadlineAt.getTime())
      failure = 'execution_timeout';
    else if (signal?.aborted) failure = 'worker_stopped';
    await this.queue.finish(claim, failure ? { error: failure, usage } : { body, usage });
    return true;
  }
}

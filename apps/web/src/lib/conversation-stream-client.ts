import {
  ConversationStreamDecoder,
  ConversationStreamDecodeError,
} from './conversation-stream-codec.js';
import {
  parseConversationStreamBootstrap,
  type ConversationStreamScope,
  type ConversationStreamBootstrap,
  type ConversationStreamEvent,
  type MessageReference,
} from './conversation-stream-contract.js';
import { parseConversationMessage, type MessageProjection } from './conversation-message.js';
import {
  applyConversationStreamEvent,
  createConversationStreamState,
  resolveConversationStreamMessage,
  resolveCancelledTaskPartial,
  type ConversationStreamState,
} from './conversation-stream-state.js';
import { parseTaskPartialOutput } from './task-partial-output.js';

export type ConversationLiveStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'forbidden'
  | 'authentication-required'
  | 'unavailable'
  | 'stopped';
interface StreamClientOptions {
  scope: ConversationStreamScope;
  request: typeof fetch;
  signal: AbortSignal;
  retryMs?: number;
  onStatus(status: ConversationLiveStatus): void;
  onReset(snapshot: ConversationStreamBootstrap): void;
  onState(state: ConversationStreamState | null): void;
  onMessage(message: MessageProjection): void;
  onClearMessage(messageId: string): void;
  /** Fired after a stream event is applied (or its message reference is resolved). */
  onEvent?(event: ConversationStreamEvent): void;
}
class StreamResponseError extends Error {
  constructor(
    readonly outcome:
      'forbidden' | 'authentication-required' | 'unavailable' | 'bootstrap' | 'retry',
  ) {
    super(outcome);
  }
}
function check(response: Response) {
  if (response.status === 401) throw new StreamResponseError('authentication-required');
  if (response.status === 403) throw new StreamResponseError('forbidden');
  if (response.status === 410 || response.status === 400)
    throw new StreamResponseError('bootstrap');
  if (!response.ok) throw new StreamResponseError('retry');
}
async function boundedJson(response: Response, controller: AbortController): Promise<unknown> {
  check(response);
  if (!response.body) throw new StreamResponseError('unavailable');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => void reader.cancel().catch(() => undefined),
    timer = setTimeout(() => controller.abort(), 30_000);
  controller.signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      controller.signal.throwIfAborted();
      const next = await reader.read();
      controller.signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1024 * 1024) throw new StreamResponseError('unavailable');
      chunks.push(next.value);
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
export async function consumeConversationStream(options: StreamClientOptions): Promise<void> {
  const { scope, request, signal } = options;
  const base = `/app/workspaces/${scope.workspaceId}/conversations/${scope.conversationId}/events`;
  let state: ConversationStreamState | undefined,
    bootstrapFailures = 0;
  const attemptedCancelled = new Set<string>();
  while (!signal.aborted) {
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let partialWork: Promise<void> | undefined, partialFailure: StreamResponseError | undefined;
    const fetchResponse = async (url: string, headers?: Record<string, string>) => {
      controller.signal.throwIfAborted();
      connectTimer = setTimeout(() => controller.abort(), 30_000);
      try {
        return await request(url, {
          method: 'GET',
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
          ...(headers ? { headers } : {}),
        });
      } finally {
        clearTimeout(connectTimer);
      }
    };
    const locate = async (reference: MessageReference) => {
      const value: unknown = await boundedJson(
        await fetchResponse(base + '/messages/' + reference.messageId),
        controller,
      );
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).join(',') !== 'message'
      )
        throw new StreamResponseError('unavailable');
      const current = parseConversationMessage((value as Record<string, unknown>).message);
      if (
        !current ||
        current.id !== reference.messageId ||
        current.creationSequence !== reference.creationSequence ||
        current.sequence < reference.sequence ||
        (reference.deleted && !current.deleted) ||
        (reference.runId !== null) !== 'kind' in current.author ||
        (current.sequence === reference.sequence &&
          current.versionEventId !== reference.versionEventId)
      )
        throw new StreamResponseError('unavailable');
      return current;
    };
    const nextCancelled = () =>
      state &&
      Object.values(state.executions).find(
        (execution) =>
          execution.runStatus === 'cancelled' && !attemptedCancelled.has(execution.runId),
      );
    // Partial detail enriches the live view; it never gates subscription or the
    // next event. One serial request is active, at most once per retained Run
    // until a fresh authorized bootstrap. Task details remain manually readable.
    const readCancelled = async () => {
      while (!controller.signal.aborted) {
        const execution = nextCancelled();
        if (!execution || !state) return;
        attemptedCancelled.add(execution.runId);
        const detail = new AbortController(),
          stopDetail = () => detail.abort(),
          timer = setTimeout(stopDetail, 30_000);
        controller.signal.addEventListener('abort', stopDetail, { once: true });
        let partial;
        try {
          const raw = await boundedJson(
            await request(
              `/app/workspaces/${scope.workspaceId}/conversations/${scope.conversationId}/tasks/${execution.taskId}/runs/${execution.runId}/partial-output`,
              {
                method: 'GET',
                credentials: 'same-origin',
                redirect: 'error',
                cache: 'no-store',
                signal: detail.signal,
              },
            ),
            detail,
          );
          partial = parseTaskPartialOutput(raw, {
            conversationId: scope.conversationId,
            taskId: execution.taskId,
            runId: execution.runId,
          });
          if (!partial) throw new StreamResponseError('unavailable');
          detail.signal.throwIfAborted();
        } catch (error) {
          if (controller.signal.aborted) return;
          if (
            error instanceof StreamResponseError &&
            ['forbidden', 'authentication-required'].includes(error.outcome)
          )
            throw error;
          // Keep already committed interrupted text and its terminal fence.
          // A missing detail is local to this Run, not a stream cursor failure.
          if (state.executions[execution.runId]?.runStatus === 'cancelled') {
            state = { ...state, previewsTruncated: true };
            options.onState(state);
          }
        } finally {
          clearTimeout(timer);
          detail.abort();
          controller.signal.removeEventListener('abort', stopDetail);
        }
        if (controller.signal.aborted) return;
        const current = state.executions[execution.runId];
        if (
          partial &&
          current?.runStatus === 'cancelled' &&
          current.taskId === execution.taskId &&
          current.attempt === execution.attempt
        ) {
          state = resolveCancelledTaskPartial(state, partial);
          options.onState(state);
        }
      }
    };
    const restoreCancelled = () => {
      if (!state || controller.signal.aborted) return;
      for (const runId of attemptedCancelled)
        if (!state.executions[runId]) attemptedCancelled.delete(runId);
      if (partialWork || !nextCancelled()) return;
      partialWork = readCancelled()
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          partialFailure =
            error instanceof StreamResponseError ? error : new StreamResponseError('unavailable');
          controller.abort();
        })
        .finally(() => {
          partialWork = undefined;
          // An event can add another cancelled Run while the previous request
          // settles. Rescan without blocking the event consumer.
          if (nextCancelled()) restoreCancelled();
        });
    };
    const cancelReader = () => void reader?.cancel().catch(() => undefined);
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      options.onStatus(state ? 'reconnecting' : 'connecting');
      if (!state) {
        attemptedCancelled.clear();
        const raw = await boundedJson(await fetchResponse(base + '/bootstrap'), controller);
        const snapshot = parseConversationStreamBootstrap(JSON.stringify(raw), scope);
        if (!snapshot) throw new StreamResponseError('unavailable');
        const candidate = createConversationStreamState(snapshot);
        options.onReset(snapshot);
        for (const reference of snapshot.messages) {
          const current = await locate(reference);
          controller.signal.throwIfAborted();
          options.onMessage(current);
        }
        state = candidate;
        options.onState(state);
      }
      restoreCancelled();
      const response = await fetchResponse(base, {
        accept: 'text/event-stream',
        'last-event-id': state.acknowledgedCursor,
      });
      check(response);
      if (
        !response.body ||
        !/^text\/event-stream(?:;|$)/iu.test(response.headers.get('content-type') ?? '')
      )
        throw new StreamResponseError('unavailable');
      reader = response.body.getReader();
      const decoder = new ConversationStreamDecoder(scope);
      options.onStatus('live');
      while (!signal.aborted) {
        const timer = setTimeout(() => controller.abort(), 30_000);
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } finally {
          clearTimeout(timer);
        }
        controller.signal.throwIfAborted();
        if (next.done) {
          // A partial final frame belongs to the interrupted transport, not the
          // acknowledgement. A fresh decoder resumes after the last applied id.
          try {
            decoder.finish();
          } catch {
            /* reconnect from the applied cursor */
          }
          throw new StreamResponseError('retry');
        }
        const frames = decoder.feed(next.value);
        for (const frame of frames) {
          if (frame.kind === 'control') {
            if (frame.code === 'conversation_forbidden') throw new StreamResponseError('forbidden');
            if (frame.code === 'authentication_required')
              throw new StreamResponseError('authentication-required');
            throw new StreamResponseError(frame.code === 'cursor_expired' ? 'bootstrap' : 'retry');
          }
          const transition = applyConversationStreamEvent(state, frame.event);
          state = transition.state;
          if (transition.clearMessageId) options.onClearMessage(transition.clearMessageId);
          if (transition.status === 'resync-required' || transition.status === 'blocked')
            throw new StreamResponseError('bootstrap');
          if (transition.status === 'resolve-message') {
            options.onState(state);
            const current = await locate(transition.reference!);
            controller.signal.throwIfAborted();
            const resolved = resolveConversationStreamMessage(state, transition.cursor!, current);
            if (resolved.status !== 'applied' && resolved.status !== 'duplicate')
              throw new StreamResponseError('bootstrap');
            options.onMessage(current);
            state = resolved.state;
          }
          options.onState(state);
          if (transition.status === 'applied' || transition.status === 'resolve-message')
            options.onEvent?.(frame.event);
          if (
            frame.event.type === 'task.run.updated' &&
            frame.event.data.execution.runStatus === 'cancelled'
          )
            restoreCancelled();
          bootstrapFailures = 0;
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      error = partialFailure ?? error;
      if (
        error instanceof ConversationStreamDecodeError ||
        (error instanceof StreamResponseError &&
          ['forbidden', 'authentication-required', 'unavailable'].includes(error.outcome))
      ) {
        options.onState(null);
        options.onStatus(
          error instanceof StreamResponseError &&
            error.outcome !== 'bootstrap' &&
            error.outcome !== 'retry'
            ? error.outcome
            : 'unavailable',
        );
        return;
      }
      if (error instanceof StreamResponseError && error.outcome === 'bootstrap') {
        state = undefined;
        options.onState(null);
        if (++bootstrapFailures > 2) {
          options.onStatus('unavailable');
          return;
        }
      }
      options.onStatus('reconnecting');
    } finally {
      clearTimeout(connectTimer);
      controller.abort();
      await partialWork;
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      controller.signal.removeEventListener('abort', cancelReader);
      signal.removeEventListener('abort', abort);
    }
    await delay(options.retryMs ?? 1000, signal);
  }
  options.onStatus('stopped');
}

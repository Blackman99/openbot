import {
  consumeConversationStream,
  type ConversationLiveStatus,
} from './conversation-stream-client.js';
import type { ConversationStreamScope } from './conversation-stream-contract.js';
import { shouldRefreshTaskUi } from './task-live-refresh.js';

export interface TaskLiveRefreshOptions {
  scope: ConversationStreamScope;
  /** When set, only events for this task reload the open detail page. */
  taskId?: string;
  request?: typeof fetch;
  signal: AbortSignal;
  retryMs?: number;
  coalesceMs?: number;
  onStatus?(status: ConversationLiveStatus): void;
  refresh(): void | Promise<void>;
}

/**
 * Reuses the COL-05 conversation SSE client so task list/detail pages reload
 * when approvals or retries land from the public API or another client.
 */
export async function watchTaskLiveRefresh(options: TaskLiveRefreshOptions): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal.addEventListener('abort', clear, { once: true });
  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void options.refresh();
    }, options.coalesceMs ?? 50);
  };
  await consumeConversationStream({
    scope: options.scope,
    request: options.request ?? fetch,
    signal: options.signal,
    retryMs: options.retryMs,
    onStatus: options.onStatus ?? (() => undefined),
    onReset: () => undefined,
    onState: () => undefined,
    onMessage: () => undefined,
    onClearMessage: () => undefined,
    onEvent(event) {
      if (shouldRefreshTaskUi(event, options.taskId)) schedule();
    },
  });
  clear();
}

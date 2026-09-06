import type { TransactionAdmission } from '../database/transaction-admission.js';
import {
  WORKSPACE_EVENT_HEARTBEAT,
  WORKSPACE_EVENT_LIMITS,
  WorkspaceEventError,
  encodeWorkspaceEventControl,
  type WorkspaceEventControl,
} from './protocol.js';

export type WorkspaceEventAdmission =
  | {
      kind: 'token';
      userId: string;
      workspaceId: string;
      admit: TransactionAdmission;
    }
  | {
      kind: 'session';
      sessionToken: string;
      userId: string;
      workspaceId: string;
    };

export interface WorkspaceEventStreamReader {
  deliver(
    admission: WorkspaceEventAdmission,
    workspaceId: string,
    cursor: string,
    enqueue: (frame: string) => void,
  ): Promise<{ cursor: string; delivered: boolean }>;
}

export interface WorkspaceEventSink {
  queuedBytes(): number;
  write(frame: string): boolean;
  drain(signal: AbortSignal): Promise<void>;
  close(): void;
}

interface DeliveryTiming {
  drainMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

async function boundedWait(
  operation: (signal: AbortSignal) => Promise<void>,
  external: AbortSignal,
  timeoutMs: number,
) {
  external.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => undefined as void;
  try {
    await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(external.reason);
        external.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new WorkspaceEventError('slow_consumer')), timeoutMs);
        if (external.aborted) abort();
      }),
    ]);
  } finally {
    external.removeEventListener('abort', abort);
    clearTimeout(timer);
    controller.abort();
  }
}

function pause(delay: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function controlCode(error: unknown): WorkspaceEventControl {
  if (error instanceof WorkspaceEventError && error.code !== 'invalid_stream_cursor')
    return error.code;
  return 'events_unavailable';
}

export async function deliverWorkspaceEventStream(
  reader: WorkspaceEventStreamReader,
  admission: WorkspaceEventAdmission,
  workspaceId: string,
  initialCursor: string,
  sink: WorkspaceEventSink,
  signal: AbortSignal,
  timing: DeliveryTiming = {},
): Promise<void> {
  let cursor = initialCursor,
    heartbeatAt = Date.now();
  try {
    while (!signal.aborted) {
      let ready = true;
      const result = await reader.deliver(admission, workspaceId, cursor, (frame) => {
        signal.throwIfAborted();
        if (
          Buffer.byteLength(frame) > WORKSPACE_EVENT_LIMITS.frameBytes ||
          sink.queuedBytes() + Buffer.byteLength(frame) > WORKSPACE_EVENT_LIMITS.queuedBytes
        )
          throw new WorkspaceEventError('slow_consumer');
        ready = sink.write(frame);
      });
      signal.throwIfAborted();
      cursor = result.cursor;
      if (
        !result.delivered &&
        Date.now() - heartbeatAt >= (timing.heartbeatMs ?? WORKSPACE_EVENT_LIMITS.heartbeatMs)
      ) {
        if (
          sink.queuedBytes() + Buffer.byteLength(WORKSPACE_EVENT_HEARTBEAT) >
          WORKSPACE_EVENT_LIMITS.queuedBytes
        )
          throw new WorkspaceEventError('slow_consumer');
        ready = sink.write(WORKSPACE_EVENT_HEARTBEAT);
        heartbeatAt = Date.now();
      }
      if (!ready)
        await boundedWait(
          (drainSignal) => sink.drain(drainSignal),
          signal,
          timing.drainMs ?? WORKSPACE_EVENT_LIMITS.drainMs,
        );
      else if (!result.delivered)
        await pause(timing.pollMs ?? WORKSPACE_EVENT_LIMITS.pollMs, signal);
    }
  } catch (error) {
    if (!signal.aborted) {
      const frame = encodeWorkspaceEventControl(controlCode(error));
      if (sink.queuedBytes() + Buffer.byteLength(frame) <= WORKSPACE_EVENT_LIMITS.queuedBytes)
        sink.write(frame);
    }
  } finally {
    sink.close();
  }
}

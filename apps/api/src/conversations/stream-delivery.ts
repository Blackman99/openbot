import {
  ConversationStreamError,
  encodeConversationStreamControl,
  STREAM_LIMITS,
  type ConversationStreamBootstrap,
  type ConversationStreamScope,
} from './stream-protocol.js';

export interface ConversationStreamReader {
  // The implementation re-admits the current human and invokes enqueue once,
  // synchronously under its resource locks. No authorized batch escapes a TX.
  deliver(
    sessionToken: string,
    scope: ConversationStreamScope,
    cursor: string,
    enqueue: (frame: string) => void,
  ): Promise<{ cursor: string; delivered: boolean }>;
}
export interface ConversationStreams extends ConversationStreamReader {
  bootstrap(
    sessionToken: string,
    scope: ConversationStreamScope,
  ): Promise<ConversationStreamBootstrap>;
  check(sessionToken: string, scope: ConversationStreamScope, cursor: unknown): Promise<string>;
}
export interface ConversationStreamSink {
  queuedBytes(): number;
  // false means the frame was accepted but no further read may start until drain.
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
        timer = setTimeout(() => reject(new ConversationStreamError('slow_consumer')), timeoutMs);
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
export async function deliverConversationStream(
  reader: ConversationStreamReader,
  sessionToken: string,
  scope: ConversationStreamScope,
  initialCursor: string,
  sink: ConversationStreamSink,
  signal: AbortSignal,
  timing: DeliveryTiming = {},
): Promise<void> {
  let cursor = initialCursor,
    heartbeatAt = Date.now();
  try {
    while (!signal.aborted) {
      let ready = true;
      const result = await reader.deliver(sessionToken, scope, cursor, (frame) => {
        signal.throwIfAborted();
        if (
          Buffer.byteLength(frame) > STREAM_LIMITS.frameBytes ||
          sink.queuedBytes() + Buffer.byteLength(frame) > STREAM_LIMITS.queuedBytes
        )
          throw new ConversationStreamError('slow_consumer');
        ready = sink.write(frame);
      });
      signal.throwIfAborted();
      cursor = result.cursor;
      if (
        !result.delivered &&
        Date.now() - heartbeatAt >= (timing.heartbeatMs ?? STREAM_LIMITS.heartbeatMs)
      ) {
        if (sink.queuedBytes() + 13 > STREAM_LIMITS.queuedBytes)
          throw new ConversationStreamError('slow_consumer');
        ready = sink.write(': heartbeat\n\n');
        heartbeatAt = Date.now();
      }
      if (!ready)
        await boundedWait(
          (drainSignal) => sink.drain(drainSignal),
          signal,
          timing.drainMs ?? STREAM_LIMITS.drainMs,
        );
      else if (!result.delivered) await pause(timing.pollMs ?? STREAM_LIMITS.pollMs, signal);
      // Every new read starts only after the preceding drain/idle wait. It must
      // reacquire current authority even when the previous cursor had more rows.
    }
  } catch (error) {
    if (!signal.aborted) {
      const code =
        error instanceof ConversationStreamError && error.code !== 'invalid_stream_cursor'
          ? error.code
          : 'conversation_stream_unavailable';
      const frame = encodeConversationStreamControl(code);
      if (sink.queuedBytes() + Buffer.byteLength(frame) <= STREAM_LIMITS.queuedBytes)
        sink.write(frame);
    }
  } finally {
    sink.close();
  }
}

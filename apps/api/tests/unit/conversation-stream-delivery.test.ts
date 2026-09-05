import { describe, expect, it } from 'vitest';
import { ConversationStreamError } from '../../src/conversations/stream-protocol.js';
import {
  deliverConversationStream,
  type ConversationStreamSink,
} from '../../src/conversations/stream-delivery.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const scope = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  conversationId: '20000000-0000-4000-8000-000000000002',
};

describe('authorized conversation stream delivery', () => {
  it('does not read ahead under backpressure and re-admits after drain before another frame', async () => {
    const draining = deferred(),
      written = deferred(),
      stopped = new AbortController();
    const frames: string[] = [];
    let admitted = 0,
      revoked = false;
    const sink: ConversationStreamSink = {
      queuedBytes: () => 0,
      write: (frame) => {
        frames.push(frame);
        written.resolve();
        return false;
      },
      drain: () => draining.promise,
      close: () => undefined,
    };
    const running = deliverConversationStream(
      {
        deliver: async (_token, _scope, cursor, enqueue) => {
          admitted++;
          if (revoked) throw new ConversationStreamError('conversation_forbidden');
          enqueue('first-authorized-frame');
          return { cursor: cursor + '-applied', delivered: true };
        },
      },
      'session',
      scope,
      'start',
      sink,
      stopped.signal,
    );
    await written.promise;
    expect(admitted).toBe(1);
    expect(frames).toEqual(['first-authorized-frame']);
    revoked = true;
    draining.resolve();
    await running;
    expect(admitted).toBe(2);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain('conversation_forbidden');
    expect(frames[1]).not.toContain('id:');
  });

  it('cancels a pending drain on disconnect without delivering or cancelling work', async () => {
    const written = deferred(),
      stopped = new AbortController();
    const frames: string[] = [];
    let reads = 0,
      closes = 0;
    const running = deliverConversationStream(
      {
        deliver: async (_token, _scope, cursor, enqueue) => {
          reads++;
          enqueue('first');
          return { cursor, delivered: true };
        },
      },
      'session',
      scope,
      'start',
      {
        queuedBytes: () => 0,
        write: (frame) => {
          frames.push(frame);
          written.resolve();
          return false;
        },
        drain: () => new Promise<void>(() => undefined),
        close: () => {
          closes++;
        },
      },
      stopped.signal,
    );
    await written.promise;
    stopped.abort();
    await running;
    expect(frames).toEqual(['first']);
    expect(reads).toBe(1);
    expect(closes).toBe(1);
  });

  it('closes a stalled consumer within its bounded drain timeout', async () => {
    const frames: string[] = [];
    await deliverConversationStream(
      {
        deliver: async (_token, _scope, cursor, enqueue) => {
          enqueue('first');
          return { cursor, delivered: true };
        },
      },
      'session',
      scope,
      'start',
      {
        queuedBytes: () => 512 * 1024,
        write: (frame) => {
          frames.push(frame);
          return false;
        },
        drain: () => new Promise<void>(() => undefined),
        close: () => undefined,
      },
      new AbortController().signal,
      { drainMs: 5 },
    );
    expect(frames).toEqual([]);
  });

  it('polls fresh authority during an idle conversation and never gives heartbeats an id', async () => {
    const frames: string[] = [];
    let reads = 0;
    await deliverConversationStream(
      {
        deliver: async (_token, _scope, cursor) => {
          reads++;
          if (reads === 3) throw new ConversationStreamError('authentication_required');
          return { cursor, delivered: false };
        },
      },
      'session',
      scope,
      'start',
      {
        queuedBytes: () => 0,
        write: (frame) => {
          frames.push(frame);
          return true;
        },
        drain: async () => undefined,
        close: () => undefined,
      },
      new AbortController().signal,
      { pollMs: 1, heartbeatMs: 0 },
    );
    expect(reads).toBe(3);
    expect(frames).toEqual([
      ': heartbeat\n\n',
      ': heartbeat\n\n',
      'event: stream.control\ndata: {"schemaVersion":1,"code":"authentication_required"}\n\n',
    ]);
  });
});

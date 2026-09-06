import { describe, expect, it } from 'vitest';
import { WorkspaceEventError } from '../../src/events/protocol.js';
import {
  deliverWorkspaceEventStream,
  type WorkspaceEventAdmission,
  type WorkspaceEventSink,
} from '../../src/events/delivery.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const admission: WorkspaceEventAdmission = {
  kind: 'session',
  sessionToken: 'a'.repeat(43),
  userId: '10000000-0000-4000-8000-000000000010',
  workspaceId: '10000000-0000-4000-8000-000000000001',
};

describe('public workspace event delivery', () => {
  it('does not read ahead under backpressure and re-admits after drain before another frame', async () => {
    const draining = deferred(),
      written = deferred(),
      stopped = new AbortController();
    const frames: string[] = [];
    let admitted = 0,
      revoked = false;
    const sink: WorkspaceEventSink = {
      queuedBytes: () => 0,
      write: (frame) => {
        frames.push(frame);
        written.resolve();
        return false;
      },
      drain: () => draining.promise,
      close: () => undefined,
    };
    const running = deliverWorkspaceEventStream(
      {
        deliver: async (_admission, _workspaceId, cursor, enqueue) => {
          admitted++;
          if (revoked) throw new WorkspaceEventError('events_forbidden');
          enqueue('first-authorized-frame');
          return { cursor: cursor + '-applied', delivered: true };
        },
      },
      admission,
      admission.workspaceId,
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
    expect(frames[1]).toContain('events_forbidden');
    expect(frames[1]).not.toContain('id:');
  });

  it('closes a stalled consumer with an explicit slow_consumer control', async () => {
    const frames: string[] = [];
    await deliverWorkspaceEventStream(
      {
        deliver: async (_admission, _workspaceId, cursor, enqueue) => {
          enqueue('first');
          return { cursor, delivered: true };
        },
      },
      admission,
      admission.workspaceId,
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

  it('emits data-free heartbeats without ids while polling fresh authority', async () => {
    const frames: string[] = [];
    let reads = 0;
    await deliverWorkspaceEventStream(
      {
        deliver: async (_admission, _workspaceId, cursor) => {
          reads++;
          if (reads === 3) throw new WorkspaceEventError('invalid_api_token');
          return { cursor, delivered: false };
        },
      },
      admission,
      admission.workspaceId,
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
      'event: stream.control\ndata: {"schemaVersion":1,"code":"invalid_api_token"}\n\n',
    ]);
  });
});

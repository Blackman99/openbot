import { describe, expect, it } from 'vitest';
import {
  WorkspaceEventError,
  encodeWorkspaceEventCursor,
  encodeWorkspaceEventFrame,
  parseWorkspaceEventCursor,
  validateWorkspaceEventPosition,
} from '../../src/events/protocol.js';

const scope = { workspaceId: '10000000-0000-4000-8000-000000000001' };
const other = { workspaceId: '10000000-0000-4000-8000-000000000099' };
const time = new Date('2026-09-06T00:00:00.000Z');

describe('public workspace event protocol', () => {
  it('binds a canonical bounded cursor to the exact workspace and safe sequence', () => {
    for (const after of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const cursor = encodeWorkspaceEventCursor(scope, after);
      expect(cursor.length).toBeLessThanOrEqual(512);
      expect(parseWorkspaceEventCursor(cursor)).toEqual({ v: 1, ...scope, after });
      expect(parseWorkspaceEventCursor(cursor, scope)).toEqual({ v: 1, ...scope, after });
      expect(Buffer.from(cursor, 'base64url').toString()).toBe(
        JSON.stringify({ v: 1, ...scope, after }),
      );
    }
  });

  it('rejects alternate encodings, unsafe offsets and cross-workspace cursors', () => {
    const cursor = encodeWorkspaceEventCursor(scope, 3);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const value of [
      undefined,
      '',
      cursor + '=',
      [cursor, cursor],
      'a'.repeat(513),
      encode({ v: 1, ...scope, after: -1 }),
      encode({ v: 1, ...scope, after: 1.5 }),
      encode({ v: 2, ...scope, after: 3 }),
      encode({ v: 1, ...scope, after: 3, conversationId: other.workspaceId }),
      encode({ after: 3, ...scope, v: 1 }),
    ])
      expect(parseWorkspaceEventCursor(value, scope)).toBeUndefined();
    expect(parseWorkspaceEventCursor(cursor, other)).toBeUndefined();
    expect(() => encodeWorkspaceEventCursor(scope, -1)).toThrow(WorkspaceEventError);
  });

  it('distinguishes an expired retention floor from future cursors', () => {
    expect(() => validateWorkspaceEventPosition(7, 7, 10)).not.toThrow();
    expect(() => validateWorkspaceEventPosition(10, 7, 10)).not.toThrow();
    expect(() => validateWorkspaceEventPosition(6, 7, 10)).toThrowError(
      expect.objectContaining({ code: 'cursor_expired', statusCode: 410 }),
    );
    expect(() => validateWorkspaceEventPosition(11, 7, 10)).toThrowError(
      expect.objectContaining({ code: 'invalid_stream_cursor', statusCode: 400 }),
    );
  });

  it('encodes durable SSE frames whose id matches the envelope cursor', () => {
    const frame = encodeWorkspaceEventFrame(scope, 4, time, 'task.updated', {
      taskId: '30000000-0000-4000-8000-000000000003',
      status: 'completed',
    });
    const cursor = encodeWorkspaceEventCursor(scope, 4);
    expect(frame).toBe(
      `id: ${cursor}\nevent: task.updated\ndata: ${JSON.stringify({
        schemaVersion: 1,
        cursor,
        workspaceId: scope.workspaceId,
        sequence: 4,
        occurredAt: time.toISOString(),
        type: 'task.updated',
        data: {
          taskId: '30000000-0000-4000-8000-000000000003',
          status: 'completed',
        },
      })}\n\n`,
    );
  });
});

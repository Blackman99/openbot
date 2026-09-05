import { describe, expect, it } from 'vitest';
import {
  ConversationStreamError,
  encodeConversationStreamCursor,
  parseConversationStreamCursor,
  encodeConversationStreamEvent,
  encodeConversationStreamControl,
  validateConversationStreamPosition,
} from '../../src/conversations/stream-protocol.js';

const scope = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  conversationId: '20000000-0000-4000-8000-000000000002',
};
const taskId = '30000000-0000-4000-8000-000000000003';
const runId = '40000000-0000-4000-8000-000000000004';
const time = new Date('2026-09-05T00:00:00.000Z');

describe('private conversation stream protocol', () => {
  it('binds a canonical bounded cursor to the exact conversation and safe sequence', () => {
    for (const after of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const cursor = encodeConversationStreamCursor(scope, after);
      expect(cursor.length).toBeLessThanOrEqual(512);
      expect(parseConversationStreamCursor(cursor, scope)).toEqual({ v: 1, ...scope, after });
      expect(Buffer.from(cursor, 'base64url').toString()).toBe(
        JSON.stringify({ v: 1, ...scope, after }),
      );
    }
  });

  it('rejects alternate encodings, unsafe offsets and cross-resource cursors', () => {
    const cursor = encodeConversationStreamCursor(scope, 3);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const invalid = [
      undefined,
      '',
      cursor + '=',
      cursor + '\n',
      [cursor, cursor],
      'a'.repeat(513),
      encode({ v: 1, ...scope, after: -1 }),
      encode({ v: 1, ...scope, after: 1.5 }),
      encode({ v: 1, ...scope, after: Number.MAX_SAFE_INTEGER + 1 }),
      encode({ v: 1, ...scope, after: '3' }),
      encode({ v: 2, ...scope, after: 3 }),
      encode({ v: 1, ...scope, after: 3, extra: true }),
      encode({ v: 1, ...scope, workspaceId: taskId, after: 3 }),
      encode({ v: 1, ...scope, conversationId: runId, after: 3 }),
      encode({ after: 3, ...scope, v: 1 }),
    ];
    for (const value of invalid)
      expect(parseConversationStreamCursor(value, scope)).toBeUndefined();
    expect(() => encodeConversationStreamCursor(scope, -1)).toThrow(ConversationStreamError);
  });

  it('distinguishes an expired prefix from future/malformed cursors at the authorized tail', () => {
    expect(() => validateConversationStreamPosition(7, 7, 10)).not.toThrow();
    expect(() => validateConversationStreamPosition(10, 7, 10)).not.toThrow();
    expect(() => validateConversationStreamPosition(6, 7, 10)).toThrowError(
      expect.objectContaining({ code: 'cursor_expired', statusCode: 410 }),
    );
    expect(() => validateConversationStreamPosition(11, 7, 10)).toThrowError(
      expect.objectContaining({ code: 'invalid_stream_cursor', statusCode: 400 }),
    );
  });

  it('encodes one durable frame with byte-correct nonempty text and matching id/envelope', () => {
    const frame = encodeConversationStreamEvent(scope, 4, time, {
      type: 'assistant.delta',
      data: { taskId, runId, attempt: 1, startByte: 0, endByte: 5, text: 'A🙂' },
    });
    const cursor = encodeConversationStreamCursor(scope, 4);
    expect(frame).toBe(
      `id: ${cursor}\nevent: assistant.delta\ndata: ${JSON.stringify({
        schemaVersion: 1,
        cursor,
        conversationId: scope.conversationId,
        sequence: 4,
        occurredAt: time.toISOString(),
        type: 'assistant.delta',
        data: { taskId, runId, attempt: 1, startByte: 0, endByte: 5, text: 'A🙂' },
      })}\n\n`,
    );
  });

  it('rejects empty, oversized, invalid scalar and mismatched byte ranges before publication', () => {
    for (const data of [
      { text: '', endByte: 0 },
      { text: '🙂', endByte: 2 },
      { text: 'a'.repeat(4097), endByte: 4097 },
      { text: '\ud800', endByte: 3 },
    ])
      expect(() =>
        encodeConversationStreamEvent(scope, 4, time, {
          type: 'assistant.delta',
          data: { taskId, runId, attempt: 1, startByte: 0, ...data },
        }),
      ).toThrow(ConversationStreamError);
  });

  it('projects message reference fields without serializing incidental object properties', () => {
    const message = {
      messageId: taskId,
      creationSequence: 1,
      versionEventId: runId,
      sequence: 3,
      deleted: true,
      taskId: null,
      runId: null,
      body: 'superseded secret body',
      attachments: [{ name: 'secret.pdf' }],
    };
    const frame = encodeConversationStreamEvent(scope, 4, time, {
      type: 'message.changed',
      data: { message },
    });
    expect(frame).not.toMatch(/secret|body|attachments/u);
    expect(frame).toContain('"deleted":true');
  });

  it('keeps transient controls content-free and without a durable acknowledgement', () => {
    expect(encodeConversationStreamControl('conversation_forbidden')).toBe(
      'event: stream.control\ndata: {"schemaVersion":1,"code":"conversation_forbidden"}\n\n',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  ConversationStreamDecoder,
  ConversationStreamDecodeError,
} from '../../src/lib/conversation-stream-codec.js';
import { encodeConversationStreamCursor } from '../../src/lib/conversation-stream-contract.js';

const scope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
};
const cursor = encodeConversationStreamCursor(scope, 1);
const event = {
  schemaVersion: 1,
  cursor,
  conversationId: scope.conversationId,
  sequence: 1,
  occurredAt: '2030-01-01T00:00:00.000Z',
  type: 'assistant.delta',
  data: {
    taskId: '33333333-3333-4333-8333-333333333333',
    runId: '44444444-4444-4444-8444-444444444444',
    attempt: 1,
    startByte: 0,
    endByte: 7,
    text: 'hi 🌍',
  },
};
const encoder = new TextEncoder();
const frame = (newline = '\n') =>
  `id: ${cursor}${newline}event: assistant.delta${newline}data: ${JSON.stringify(event)}${newline}${newline}`;

describe('bounded conversation SSE decoder', () => {
  it.each(['\n', '\r\n', '\r'])(
    'decodes one complete durable event across every %j/UTF-8 byte split',
    (newline) => {
      const bytes = encoder.encode(frame(newline));
      for (let split = 0; split <= bytes.length; split++) {
        const decoder = new ConversationStreamDecoder(scope);
        const frames = [
          ...decoder.feed(bytes.subarray(0, split)),
          ...decoder.feed(bytes.subarray(split)),
          ...decoder.finish(),
        ];
        expect(frames, `byte split ${split}`).toEqual([{ kind: 'event', event }]);
      }
    },
  );

  it('preserves multiline data and split CRLF without inventing an empty frame', () => {
    const json = JSON.stringify(event),
      split = json.indexOf(',') + 1;
    const text = `\ufeff: heartbeat\r\nid: ${cursor}\r\nevent: assistant.delta\r\ndata: ${json.slice(0, split)}\r\ndata: ${json.slice(split)}\r\n\r\n`;
    const decoder = new ConversationStreamDecoder(scope);
    const frames = Array.from(encoder.encode(text)).flatMap((byte) =>
      decoder.feed(new Uint8Array([byte])),
    );
    expect([...frames, ...decoder.finish()]).toEqual([{ kind: 'event', event }]);
  });

  it('returns only content-free controls and ignores heartbeat comments without acknowledgement', () => {
    const decoder = new ConversationStreamDecoder(scope);
    const frames = decoder.feed(
      encoder.encode(
        ': ping\n\nevent: stream.control\ndata: {"schemaVersion":1,"code":"cursor_expired"}\n\n',
      ),
    );
    expect(frames).toEqual([{ kind: 'control', code: 'cursor_expired' }]);
    expect(decoder.finish()).toEqual([]);
  });

  it.each([
    () => frame().replace(`id: ${cursor}`, `id: ${cursor}\nid: ${cursor}`),
    () => frame().replace(`id: ${cursor}`, `id: ${cursor}\0`),
    () => frame().replace(`id: ${cursor}`, 'id: invalid'),
    () => frame().replace('event: assistant.delta', 'event: message.changed'),
    () => frame().replace('event: assistant.delta\n', ''),
    () => frame().replace(`id: ${cursor}\n`, ''),
    () => frame().replace('"endByte":7', '"endByte":5'),
    () => frame().replace('"text":"hi 🌍"', '"text":"hi 🌍","secret":"no"'),
    () =>
      `id: ${cursor}\nevent: stream.control\ndata: {"schemaVersion":1,"code":"slow_consumer"}\n\n`,
    () =>
      'event: stream.control\ndata: {"schemaVersion":1,"code":"conversation_forbidden","body":"private"}\n\n',
  ])('rejects malformed or ambiguous frame %# before returning it', (invalid) => {
    expect(() => new ConversationStreamDecoder(scope).feed(encoder.encode(invalid()))).toThrow(
      ConversationStreamDecodeError,
    );
  });

  it('never dispatches a truncated durable frame and cannot continue a failed decoder', () => {
    const decoder = new ConversationStreamDecoder(scope);
    expect(decoder.feed(encoder.encode(frame().slice(0, -1)))).toEqual([]);
    expect(() => decoder.finish()).toThrow(ConversationStreamDecodeError);
    expect(() => decoder.feed(encoder.encode('\n'))).toThrow(ConversationStreamDecodeError);
    const brokenUtf8 = new ConversationStreamDecoder(scope);
    expect(brokenUtf8.feed(new Uint8Array([0xf0, 0x9f]))).toEqual([]);
    expect(() => brokenUtf8.finish()).toThrow(ConversationStreamDecodeError);
  });

  it('enforces the complete encoded frame bound, including comment bytes and CRLF terminators', () => {
    const suffix = frame('\r\n');
    const padding = 262144 - encoder.encode(suffix).byteLength - 3;
    const exact = ':' + 'x'.repeat(padding) + '\r\n' + suffix;
    expect(encoder.encode(exact)).toHaveLength(262144);
    const decoder = new ConversationStreamDecoder(scope);
    expect([...decoder.feed(encoder.encode(exact)), ...decoder.finish()]).toEqual([
      { kind: 'event', event },
    ]);
    const oversized = new ConversationStreamDecoder(scope);
    expect(() =>
      oversized.feed(encoder.encode(':' + 'x'.repeat(padding + 1) + '\r\n' + suffix)),
    ).toThrow(ConversationStreamDecodeError);
  });

  it('rejects invalid UTF-8 and bounded read-ahead overflow without exposing a frame', () => {
    expect(() => new ConversationStreamDecoder(scope).feed(new Uint8Array([0xff, 0x0a]))).toThrow(
      ConversationStreamDecodeError,
    );
    expect(() => new ConversationStreamDecoder(scope).feed(new Uint8Array(524289))).toThrow(
      ConversationStreamDecodeError,
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  AnthropicMessageDecoder,
  parseAnthropicMessage,
} from '../../src/providers/anthropic-events.js';

function frame(value: Record<string, unknown>): string {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

describe('Anthropic Messages model events', () => {
  it('normalizes a plain message into text, cumulative usage, and its stop reason', () => {
    expect(
      parseAnthropicMessage(
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello 世界' }],
          usage: { input_tokens: 12, output_tokens: 4 },
          stop_reason: 'end_turn',
        }),
      ),
    ).toEqual([
      { type: 'text', text: 'Hello 世界' },
      { type: 'usage', inputTokens: 12, outputTokens: 4 },
      { type: 'complete', stopReason: 'end_turn' },
    ]);
  });
  it('normalizes only client tool_use blocks into structured actions', () => {
    expect(
      parseAnthropicMessage(
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'hosted',
              name: 'web_search',
              input: { query: 'hello' },
            },
            { type: 'tool_use', id: 'action-1', name: 'openbot_probe', input: { ok: true } },
          ],
          stop_reason: 'tool_use',
        }),
      ),
    ).toEqual([
      { type: 'action', id: 'action-1', name: 'openbot_probe', arguments: { ok: true } },
      { type: 'complete', stopReason: 'tool_use' },
    ]);
  });
  it.each([-1, 1.5, '12', null])(
    'rejects invalid usage %s instead of emitting untrusted counts',
    (count) => {
      expect(() =>
        parseAnthropicMessage(
          JSON.stringify({
            type: 'message',
            content: [],
            usage: { input_tokens: count, output_tokens: 1 },
            stop_reason: 'end_turn',
          }),
        ),
      ).toThrow('provider_invalid_response');
    },
  );
  it('emits text before EOF across chunk boundaries and completes only on message_stop', () => {
    const decoder = new AnthropicMessageDecoder(true);
    const start = frame({
      type: 'message_start',
      message: { type: 'message', content: [], usage: { input_tokens: 10, output_tokens: 1 } },
    });
    expect(decoder.feed(start.slice(0, 12))).toEqual([]);
    expect(decoder.feed(start.slice(12))).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 1 },
    ]);
    expect(
      decoder.feed(
        frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ),
    ).toEqual([]);
    expect(
      decoder.feed(
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        }),
      ),
    ).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(decoder.feed(frame({ type: 'content_block_stop', index: 0 }))).toEqual([]);
    expect(
      decoder.feed(
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 5 },
        }),
      ),
    ).toEqual([{ type: 'usage', inputTokens: 10, outputTokens: 5 }]);
    expect(decoder.feed(frame({ type: 'message_stop' }))).toEqual([
      { type: 'complete', stopReason: 'end_turn' },
    ]);
    expect(decoder.finish('')).toEqual([]);
  });
  it('accumulates each streamed tool argument independently and emits once at block stop', () => {
    const decoder = new AnthropicMessageDecoder(true);
    decoder.feed(frame({ type: 'message_start', message: {} }));
    for (const [index, id, name] of [
      [0, 'a', 'first'],
      [1, 'b', 'second'],
    ] as const) {
      expect(
        decoder.feed(
          frame({
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id, name, input: {} },
          }),
        ),
      ).toEqual([]);
    }
    for (const [index, partial_json] of [
      [0, '{"ok":'],
      [1, '{"text":"世'],
      [0, 'true}'],
      [1, '界"}'],
    ] as const) {
      expect(
        decoder.feed(
          frame({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json },
          }),
        ),
      ).toEqual([]);
    }
    expect(decoder.feed(frame({ type: 'content_block_stop', index: 1 }))).toEqual([
      { type: 'action', id: 'b', name: 'second', arguments: { text: '世界' } },
    ]);
    expect(decoder.feed(frame({ type: 'content_block_stop', index: 0 }))).toEqual([
      { type: 'action', id: 'a', name: 'first', arguments: { ok: true } },
    ]);
    decoder.feed(frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
    expect(decoder.feed(frame({ type: 'message_stop' }))).toEqual([
      { type: 'complete', stopReason: 'tool_use' },
    ]);
    expect(decoder.finish('')).toEqual([]);
  });
  it.each([
    ['overloaded_error', 'provider_unavailable'],
    ['api_error', 'provider_unavailable'],
    ['rate_limit_error', 'provider_rate_limited'],
    ['authentication_error', 'provider_authentication_failed'],
    ['invalid_request_error', 'provider_request_failed'],
  ])('normalizes the in-stream %s error without reflecting its message', (type, code) => {
    const decoder = new AnthropicMessageDecoder(true);
    expect(() =>
      decoder.feed(frame({ type: 'error', error: { type, message: 'secret-upstream-body' } })),
    ).toThrow(code);
  });
  it('ignores unknown events and ping without mistaking them for completion', () => {
    const decoder = new AnthropicMessageDecoder(true);
    expect(decoder.feed(frame({ type: 'future_event' }) + frame({ type: 'ping' }))).toEqual([]);
    expect(() => decoder.finish('')).toThrow('provider_interrupted_stream');
  });
  it('rejects malformed streamed arguments with a stable error', () => {
    const decoder = new AnthropicMessageDecoder(true);
    decoder.feed(frame({ type: 'message_start', message: {} }));
    decoder.feed(
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'a', name: 'first', input: {} },
      }),
    );
    decoder.feed(
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"secret' },
      }),
    );
    expect(() => decoder.feed(frame({ type: 'content_block_stop', index: 0 }))).toThrow(
      'provider_invalid_response',
    );
  });
  it('rejects reused content indices after emitting a completed action', () => {
    const decoder = new AnthropicMessageDecoder(true);
    decoder.feed(frame({ type: 'message_start', message: {} }));
    const block = frame({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'a', name: 'first', input: {} },
    });
    decoder.feed(block);
    decoder.feed(frame({ type: 'content_block_stop', index: 0 }));
    expect(() => decoder.feed(block)).toThrow('provider_invalid_response');
  });
});

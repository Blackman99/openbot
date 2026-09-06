import { ProviderError } from './url-policy.js';
import { isRecord, type ModelEvent } from './model-events.js';
import { SseDecoder } from './sse.js';

function invalid(): never {
  throw new ProviderError('provider_invalid_response');
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return invalid();
  }
}

function tokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}

function providerError(value: unknown): never {
  const type = isRecord(value) ? value.type : undefined;
  throw new ProviderError(
    type === 'overloaded_error' || type === 'api_error'
      ? 'provider_unavailable'
      : type === 'rate_limit_error'
        ? 'provider_rate_limited'
        : type === 'authentication_error' || type === 'permission_error'
          ? 'provider_authentication_failed'
          : 'provider_request_failed',
  );
}

export function parseAnthropicMessage(raw: string): ModelEvent[] {
  const message = parseJson(raw);
  if (isRecord(message) && message.type === 'error') return providerError(message.error);
  if (!isRecord(message) || message.type !== 'message' || !Array.isArray(message.content))
    return invalid();
  const events: ModelEvent[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) return invalid();
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return invalid();
      events.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      if (
        typeof block.id !== 'string' ||
        !block.id ||
        typeof block.name !== 'string' ||
        !block.name ||
        !isRecord(block.input)
      )
        return invalid();
      events.push({ type: 'action', id: block.id, name: block.name, arguments: block.input });
    }
  }
  if (isRecord(message.usage)) {
    events.push({
      type: 'usage',
      inputTokens: tokenCount(message.usage.input_tokens),
      outputTokens: tokenCount(message.usage.output_tokens),
    });
  }
  if (typeof message.stop_reason !== 'string' || !message.stop_reason) return invalid();
  events.push({ type: 'complete', stopReason: message.stop_reason });
  return events;
}

export class AnthropicMessageDecoder {
  private readonly sse = new SseDecoder();
  private started = false;
  private completed = false;
  private stopReason = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly seenIndices = new Set<number>();
  private readonly blocks = new Map<
    number,
    {
      kind: string;
      tool?: { id: string; name: string; input: Record<string, unknown>; fragments: string };
    }
  >();
  constructor(private readonly stream: boolean) {}
  feed(chunk: string): ModelEvent[] {
    if (!this.stream) return [];
    return this.sse.feed(chunk).flatMap(({ event, data }) => {
      const value = parseJson(data);
      if (!isRecord(value) || typeof value.type !== 'string' || (event && event !== value.type))
        return invalid();
      if (value.type === 'error') return providerError(value.error);
      if (
        ![
          'message_start',
          'content_block_start',
          'content_block_delta',
          'content_block_stop',
          'message_delta',
          'message_stop',
        ].includes(value.type)
      )
        return [];
      if (this.completed) return invalid();
      if (value.type === 'message_start') {
        if (this.started || !isRecord(value.message)) return invalid();
        this.started = true;
        return this.usage(value.message.usage);
      }
      if (!this.started) return invalid();
      if (value.type === 'content_block_start') {
        const index = tokenCount(value.index);
        if (
          this.seenIndices.has(index) ||
          !isRecord(value.content_block) ||
          typeof value.content_block.type !== 'string'
        )
          return invalid();
        this.seenIndices.add(index);
        const content = value.content_block;
        const block: {
          kind: string;
          tool?: { id: string; name: string; input: Record<string, unknown>; fragments: string };
        } = { kind: content.type as string };
        if (content.type === 'tool_use') {
          if (
            typeof content.id !== 'string' ||
            !content.id ||
            typeof content.name !== 'string' ||
            !content.name ||
            !isRecord(content.input)
          )
            return invalid();
          block.tool = { id: content.id, name: content.name, input: content.input, fragments: '' };
        }
        this.blocks.set(index, block);
        if (value.content_block.type === 'text') {
          if (typeof value.content_block.text !== 'string') return invalid();
          return value.content_block.text ? [{ type: 'text', text: value.content_block.text }] : [];
        }
      } else if (value.type === 'content_block_delta') {
        const block = this.blocks.get(tokenCount(value.index));
        if (!block || !isRecord(value.delta)) return invalid();
        if (value.delta.type === 'text_delta') {
          if (block.kind !== 'text' || typeof value.delta.text !== 'string') return invalid();
          return [{ type: 'text', text: value.delta.text }];
        } else if (value.delta.type === 'input_json_delta' && block.kind === 'tool_use') {
          if (!block.tool || typeof value.delta.partial_json !== 'string') return invalid();
          block.tool.fragments += value.delta.partial_json;
        }
      } else if (value.type === 'content_block_stop') {
        const index = tokenCount(value.index);
        const block = this.blocks.get(index);
        if (!block) return invalid();
        this.blocks.delete(index);
        if (block.tool) {
          const args: unknown = block.tool.fragments
            ? parseJson(block.tool.fragments)
            : block.tool.input;
          if (!isRecord(args)) return invalid();
          return [{ type: 'action', id: block.tool.id, name: block.tool.name, arguments: args }];
        }
      } else if (value.type === 'message_delta') {
        if (!isRecord(value.delta)) return invalid();
        if (value.delta.stop_reason !== undefined && value.delta.stop_reason !== null) {
          if (typeof value.delta.stop_reason !== 'string' || !value.delta.stop_reason)
            return invalid();
          this.stopReason = value.delta.stop_reason;
        }
        return this.usage(value.usage);
      } else if (value.type === 'message_stop') {
        if (!this.stopReason || this.blocks.size > 0) return invalid();
        this.completed = true;
        return [{ type: 'complete', stopReason: this.stopReason }];
      }
      return [];
    });
  }
  finish(raw: string): ModelEvent[] {
    if (!this.stream) return parseAnthropicMessage(raw);
    if (!this.completed || this.sse.hasPendingData)
      throw new ProviderError('provider_interrupted_stream');
    return [];
  }
  private usage(value: unknown): ModelEvent[] {
    if (value === undefined) return [];
    if (!isRecord(value)) return invalid();
    if (value.input_tokens !== undefined) this.inputTokens = tokenCount(value.input_tokens);
    if (value.output_tokens !== undefined) this.outputTokens = tokenCount(value.output_tokens);
    return [{ type: 'usage', inputTokens: this.inputTokens, outputTokens: this.outputTokens }];
  }
}

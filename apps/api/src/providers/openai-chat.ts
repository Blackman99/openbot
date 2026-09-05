import {
  isRecord,
  type ModelAdapter,
  type ModelEvent,
  type ModelEventConsumer,
  type ModelInput,
} from './model-events.js';
import { SseDecoder } from './sse.js';
import { executeModelRequest, upstreamErrorCode } from './model-request.js';
import { ProviderError, type ProviderUrlPolicy } from './url-policy.js';

function action(call: unknown): ModelEvent {
  if (
    !isRecord(call) ||
    call.type !== 'function' ||
    typeof call.id !== 'string' ||
    !call.id ||
    !isRecord(call.function) ||
    typeof call.function.name !== 'string' ||
    !call.function.name ||
    typeof call.function.arguments !== 'string'
  )
    throw new ProviderError('provider_invalid_response');
  const args: unknown = JSON.parse(call.function.arguments);
  if (!isRecord(args)) throw new ProviderError('provider_invalid_response');
  return { type: 'action', id: call.id, name: call.function.name, arguments: args };
}
function usage(value: unknown): ModelEvent[] {
  return isRecord(value) &&
    typeof value.prompt_tokens === 'number' &&
    typeof value.completion_tokens === 'number'
    ? [{ type: 'usage', inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens }]
    : [];
}
export function parseChatMessage(raw: string): ModelEvent[] {
  const value: unknown = JSON.parse(raw);
  if (isRecord(value) && value.error) throw new ProviderError(upstreamErrorCode(value));
  if (!isRecord(value) || !Array.isArray(value.choices))
    throw new ProviderError('provider_invalid_response');
  const choice: unknown = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.finish_reason !== 'string')
    throw new ProviderError('provider_invalid_response');
  const events: ModelEvent[] = [];
  if (typeof choice.message.content === 'string')
    events.push({ type: 'text', text: choice.message.content });
  if (Array.isArray(choice.message.tool_calls))
    events.push(...choice.message.tool_calls.map(action));
  events.push(...usage(value.usage), { type: 'complete', stopReason: choice.finish_reason });
  return events;
}
export class ChatEventDecoder {
  private readonly sse = new SseDecoder();
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private stopReason: string | undefined;
  private done = false;
  feed(chunk: string): ModelEvent[] {
    const events: ModelEvent[] = [];
    for (const frame of this.sse.feed(chunk)) {
      if (this.done) throw new ProviderError('provider_invalid_response');
      if (frame.data === '[DONE]') {
        if (!this.stopReason) throw new ProviderError('provider_interrupted_stream');
        for (const call of this.calls.values())
          events.push(
            action({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.args },
            }),
          );
        events.push({ type: 'complete', stopReason: this.stopReason });
        this.done = true;
        continue;
      }
      const value: unknown = JSON.parse(frame.data);
      if (!isRecord(value)) throw new ProviderError('provider_invalid_response');
      if (value.error) throw new ProviderError(upstreamErrorCode(value));
      events.push(...usage(value.usage));
      const choice: unknown = Array.isArray(value.choices) ? value.choices[0] : undefined;
      if (!isRecord(choice)) continue;
      if (isRecord(choice.delta)) {
        if (this.stopReason && (choice.delta.content || choice.delta.tool_calls))
          throw new ProviderError('provider_invalid_response');
        if (typeof choice.delta.content === 'string')
          events.push({ type: 'text', text: choice.delta.content });
        if (Array.isArray(choice.delta.tool_calls))
          for (const call of choice.delta.tool_calls) {
            if (!isRecord(call) || typeof call.index !== 'number' || !isRecord(call.function))
              throw new ProviderError('provider_invalid_response');
            const current = this.calls.get(call.index) ?? { id: '', name: '', args: '' };
            if (typeof call.id === 'string') current.id += call.id;
            if (typeof call.function.name === 'string') current.name += call.function.name;
            if (typeof call.function.arguments === 'string')
              current.args += call.function.arguments;
            this.calls.set(call.index, current);
          }
      }
      if (typeof choice.finish_reason === 'string') this.stopReason = choice.finish_reason;
    }
    return events;
  }
  finish(): ModelEvent[] {
    if (!this.done || this.sse.hasPendingData)
      throw new ProviderError('provider_interrupted_stream');
    return [];
  }
}
export class OpenAiChatAdapter implements ModelAdapter {
  constructor(
    private readonly policy: ProviderUrlPolicy,
    private readonly options: { timeoutMs?: number } = {},
  ) {}
  generate(input: ModelInput, signal?: AbortSignal, onEvent?: ModelEventConsumer) {
    return executeModelRequest(
      {
        policy: this.policy,
        options: this.options,
        input,
        baseUrl: input.baseUrl,
        path: '/chat/completions',
        stream: input.stream,
        headers: {
          ...input.headers,
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: {
          model: input.modelId,
          messages: input.messages,
          stream: input.stream,
          ...(input.tools
            ? { tools: input.tools.map((tool) => ({ type: 'function', function: tool })) }
            : {}),
          ...(input.toolChoice
            ? { tool_choice: { type: 'function', function: { name: input.toolChoice } } }
            : {}),
          ...(input.maxOutputTokens ? { max_completion_tokens: input.maxOutputTokens } : {}),
        },
        decoder: input.stream
          ? new ChatEventDecoder()
          : { feed: () => [], finish: parseChatMessage },
      },
      signal,
      onEvent,
    );
  }
}

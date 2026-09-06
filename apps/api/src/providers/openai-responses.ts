import {
  isRecord,
  type ModelAdapter,
  type ModelEvent,
  type ModelEventConsumer,
  type ModelInput,
} from './model-events.js';
import { executeModelRequest, upstreamErrorCode } from './model-request.js';
import { openaiResponsesInput } from './vision-messages.js';
import { SseDecoder } from './sse.js';
import { ProviderError, type ProviderUrlPolicy } from './url-policy.js';

function action(item: Record<string, unknown>): ModelEvent {
  if (
    typeof item.call_id !== 'string' ||
    !item.call_id ||
    typeof item.name !== 'string' ||
    !item.name ||
    typeof item.arguments !== 'string'
  )
    throw new ProviderError('provider_invalid_response');
  const args: unknown = JSON.parse(item.arguments);
  if (!isRecord(args)) throw new ProviderError('provider_invalid_response');
  return { type: 'action', id: item.call_id, name: item.name, arguments: args };
}

export function parseResponsesMessage(raw: string): ModelEvent[] {
  const value: unknown = JSON.parse(raw);
  if (isRecord(value) && (value.error || value.status === 'failed'))
    throw new ProviderError(upstreamErrorCode(value));
  if (!isRecord(value) || value.status !== 'completed' || !Array.isArray(value.output))
    throw new ProviderError('provider_invalid_response');
  const events: ModelEvent[] = [];
  for (const item of value.output) {
    if (!isRecord(item)) continue;
    if (item.type === 'function_call') events.push(action(item));
    if (item.type === 'message' && Array.isArray(item.content))
      for (const content of item.content) {
        if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string')
          events.push({ type: 'text', text: content.text });
      }
  }
  if (
    isRecord(value.usage) &&
    typeof value.usage.input_tokens === 'number' &&
    typeof value.usage.output_tokens === 'number'
  )
    events.push({
      type: 'usage',
      inputTokens: value.usage.input_tokens,
      outputTokens: value.usage.output_tokens,
    });
  events.push({
    type: 'complete',
    stopReason: events.some((event) => event.type === 'action') ? 'tool_calls' : 'stop',
  });
  return events;
}
export class ResponsesEventDecoder {
  private readonly sse = new SseDecoder();
  private readonly textItems = new Set<string>();
  private completed = false;
  private readonly calls = new Map<
    number,
    { item: Record<string, unknown>; args: string; done: boolean }
  >();
  feed(chunk: string): ModelEvent[] {
    const events: ModelEvent[] = [];
    for (const frame of this.sse.feed(chunk)) {
      const value: unknown = JSON.parse(frame.data);
      if (!isRecord(value)) throw new ProviderError('provider_invalid_response');
      if (value.type === 'error' || value.type === 'response.failed')
        throw new ProviderError(
          upstreamErrorCode(value.type === 'response.failed' ? value.response : value),
        );
      if (value.type === 'response.incomplete')
        throw new ProviderError('provider_interrupted_stream');
      if (this.completed) throw new ProviderError('provider_invalid_response');
      if (value.type === 'response.output_text.delta') {
        if (typeof value.delta !== 'string') throw new ProviderError('provider_invalid_response');
        this.textItems.add(`${value.output_index}:${value.content_index}`);
        events.push({ type: 'text', text: value.delta });
      }
      if (
        value.type === 'response.output_item.added' &&
        isRecord(value.item) &&
        value.item.type === 'function_call'
      ) {
        if (typeof value.output_index !== 'number' || this.calls.has(value.output_index))
          throw new ProviderError('provider_invalid_response');
        this.calls.set(value.output_index, {
          item: value.item,
          args: typeof value.item.arguments === 'string' ? value.item.arguments : '',
          done: false,
        });
      }
      if (value.type === 'response.function_call_arguments.delta') {
        const call =
          typeof value.output_index === 'number' ? this.calls.get(value.output_index) : undefined;
        if (!call || call.done || value.item_id !== call.item.id || typeof value.delta !== 'string')
          throw new ProviderError('provider_invalid_response');
        call.args += value.delta;
      }
      if (value.type === 'response.function_call_arguments.done') {
        const call =
          typeof value.output_index === 'number' ? this.calls.get(value.output_index) : undefined;
        if (
          !call ||
          value.item_id !== call.item.id ||
          typeof value.arguments !== 'string' ||
          (call.args && call.args !== value.arguments)
        )
          throw new ProviderError('provider_invalid_response');
        call.args = value.arguments;
      }
      if (
        value.type === 'response.output_item.done' &&
        isRecord(value.item) &&
        value.item.type === 'function_call'
      ) {
        const call =
          typeof value.output_index === 'number' ? this.calls.get(value.output_index) : undefined;
        if (
          !call ||
          call.done ||
          value.item.id !== call.item.id ||
          value.item.call_id !== call.item.call_id ||
          value.item.name !== call.item.name ||
          (call.args && call.args !== value.item.arguments)
        )
          throw new ProviderError('provider_invalid_response');
        events.push(action(value.item));
        call.done = true;
      }
      if (value.type === 'response.completed') {
        if (!isRecord(value.response) || !Array.isArray(value.response.output))
          throw new ProviderError('provider_invalid_response');
        const response = {
          ...value.response,
          output: value.response.output.map((item: unknown, index: number) =>
            isRecord(item) && item.type === 'function_call' && this.calls.get(index)?.done
              ? { type: 'already_emitted' }
              : isRecord(item) && Array.isArray(item.content)
                ? {
                    ...item,
                    content: item.content.filter(
                      (_part: unknown, contentIndex: number) =>
                        !this.textItems.has(`${index}:${contentIndex}`),
                    ),
                  }
                : item,
          ),
        };
        const finalEvents = parseResponsesMessage(JSON.stringify(response));
        if ([...this.calls.values()].some((call) => !call.done)) {
          for (const [index, call] of this.calls) {
            if (!call.done) {
              const item: unknown = value.response.output[index];
              if (
                !isRecord(item) ||
                item.type !== 'function_call' ||
                item.call_id !== call.item.call_id ||
                item.id !== call.item.id ||
                item.name !== call.item.name ||
                (call.args && call.args !== item.arguments)
              )
                throw new ProviderError('provider_interrupted_stream');
            }
          }
        }
        if (this.calls.size)
          for (const event of finalEvents)
            if (event.type === 'complete') event.stopReason = 'tool_calls';
        events.push(...finalEvents);
        this.completed = true;
      }
    }
    return events;
  }
  finish(): ModelEvent[] {
    if (!this.completed || this.sse.hasPendingData)
      throw new ProviderError('provider_interrupted_stream');
    return [];
  }
}
export class OpenAiResponsesAdapter implements ModelAdapter {
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
        path: '/responses',
        stream: input.stream,
        headers: {
          ...input.headers,
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: {
          model: input.modelId,
          input: openaiResponsesInput(input.messages),
          stream: input.stream,
          ...(input.tools
            ? { tools: input.tools.map((tool) => ({ type: 'function', ...tool })) }
            : {}),
          ...(input.toolChoice
            ? { tool_choice: { type: 'function', name: input.toolChoice } }
            : {}),
          ...(input.maxOutputTokens ? { max_output_tokens: input.maxOutputTokens } : {}),
        },
        decoder: input.stream
          ? new ResponsesEventDecoder()
          : { feed: () => [], finish: parseResponsesMessage },
      },
      signal,
      onEvent,
    );
  }
}

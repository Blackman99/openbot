import type {
  ModelAdapter,
  ModelEventConsumer,
  ModelInput,
  ModelResponse,
} from './model-events.js';
import type { ProviderUrlPolicy } from './url-policy.js';
import { executeModelRequest } from './model-request.js';
import { AnthropicMessageDecoder } from './anthropic-events.js';

export class AnthropicMessagesAdapter implements ModelAdapter {
  constructor(
    private readonly policy: ProviderUrlPolicy,
    private readonly options: { timeoutMs?: number } = {},
  ) {}
  async generate(
    input: ModelInput,
    signal?: AbortSignal,
    onEvent?: ModelEventConsumer,
  ): Promise<ModelResponse> {
    const system = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    return executeModelRequest(
      {
        policy: this.policy,
        options: this.options,
        input,
        baseUrl: input.baseUrl,
        path: '/messages',
        headers: {
          ...input.headers,
          ...(input.apiKey ? { 'x-api-key': input.apiKey } : {}),
          'anthropic-version': input.anthropicVersion ?? '2023-06-01',
        },
        body: {
          model: input.modelId,
          max_tokens: input.maxOutputTokens ?? 256,
          messages: input.messages.filter((message) => message.role !== 'system'),
          stream: input.stream,
          ...(system ? { system } : {}),
          ...(input.tools
            ? {
                tools: input.tools.map((tool) => ({
                  name: tool.name,
                  ...(tool.description === undefined ? {} : { description: tool.description }),
                  input_schema: tool.parameters,
                })),
              }
            : {}),
          ...(input.toolChoice ? { tool_choice: { type: 'tool', name: input.toolChoice } } : {}),
        },
        stream: input.stream,
        decoder: new AnthropicMessageDecoder(input.stream),
      },
      signal,
      onEvent,
    );
  }
}

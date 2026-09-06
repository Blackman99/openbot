import type { ModelAdapter, ProviderProtocol } from './model-events.js';
import {
  ModelConnectionProbe,
  type ConnectionProbe,
  type ProbeInput,
  type ProbeAdmission,
} from './model-probe.js';
import { OpenAiChatAdapter } from './openai-chat.js';
import { OpenAiResponsesAdapter } from './openai-responses.js';
import { AnthropicMessagesAdapter } from './anthropic-messages.js';
import { ProviderError, type ProviderUrlPolicy } from './url-policy.js';

export function createModelAdapter(
  protocol: ProviderProtocol,
  policy: ProviderUrlPolicy,
  options: { timeoutMs?: number } = {},
): ModelAdapter {
  if (protocol === 'openai-chat') return new OpenAiChatAdapter(policy, options);
  if (protocol === 'openai-responses') return new OpenAiResponsesAdapter(policy, options);
  if (protocol === 'anthropic-messages') return new AnthropicMessagesAdapter(policy, options);
  throw new ProviderError('provider_protocol_unsupported');
}

export class ProtocolConnectionProbe implements ConnectionProbe {
  constructor(
    private readonly policy: ProviderUrlPolicy,
    private readonly options: { timeoutMs?: number; clock?: () => Date } = {},
  ) {}
  run(input: ProbeInput, signal?: AbortSignal, beforeRequest?: ProbeAdmission) {
    return new ModelConnectionProbe(
      createModelAdapter(input.protocol ?? 'openai-chat', this.policy, this.options),
      this.options,
    ).run(input, signal, beforeRequest);
  }
}

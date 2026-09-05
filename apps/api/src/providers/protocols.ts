import type { ModelAdapter, ProviderProtocol } from './model-events.js';
import { ModelConnectionProbe, type ConnectionProbe, type ProbeInput } from './model-probe.js';
import { OpenAiChatAdapter } from './openai-chat.js';
import { OpenAiResponsesAdapter } from './openai-responses.js';
import { ProviderError, type ProviderUrlPolicy } from './url-policy.js';

export function createModelAdapter(
  protocol: ProviderProtocol,
  policy: ProviderUrlPolicy,
  options: { timeoutMs?: number } = {},
): ModelAdapter {
  if (protocol === 'openai-chat') return new OpenAiChatAdapter(policy, options);
  if (protocol === 'openai-responses') return new OpenAiResponsesAdapter(policy, options);
  throw new ProviderError('provider_protocol_unsupported');
}

export class ProtocolConnectionProbe implements ConnectionProbe {
  constructor(
    private readonly policy: ProviderUrlPolicy,
    private readonly options: { timeoutMs?: number; clock?: () => Date } = {},
  ) {}
  run(input: ProbeInput, signal?: AbortSignal) {
    return new ModelConnectionProbe(
      createModelAdapter(input.protocol ?? 'openai-chat', this.policy, this.options),
      this.options,
    ).run(input, signal);
  }
}

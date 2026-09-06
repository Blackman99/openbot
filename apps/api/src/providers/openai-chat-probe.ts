import { ModelConnectionProbe } from './model-probe.js';
import { OpenAiChatAdapter } from './openai-chat.js';
import type { ProviderUrlPolicy } from './url-policy.js';

export type { ProbeInput, ProbeResult, ProbeReport, ConnectionProbe } from './model-probe.js';
export class OpenAiChatProbe extends ModelConnectionProbe {
  constructor(policy: ProviderUrlPolicy, options: { timeoutMs?: number; clock?: () => Date } = {}) {
    super(new OpenAiChatAdapter(policy, options), options);
  }
}

import type { ModelAdapter, ModelInput, ProviderProtocol } from './model-events.js';
import { redactProviderText, type ProviderCredentials } from './secrets.js';

export interface ProbeInput extends ProviderCredentials {
  baseUrl: string;
  modelId: string;
  protocol?: ProviderProtocol;
  anthropicVersion?: string;
}
export interface ProbeResult {
  ok: boolean;
  code: string;
  raw: string;
}
export interface ProbeReport {
  testedAt: string;
  text: ProbeResult;
  action: ProbeResult;
}
export interface ConnectionProbe {
  run(input: ProbeInput, signal?: AbortSignal): Promise<ProbeReport>;
}

export class ModelConnectionProbe implements ConnectionProbe {
  constructor(
    private readonly adapter: ModelAdapter,
    private readonly options: { timeoutMs?: number; clock?: () => Date } = {},
  ) {}
  async run(input: ProbeInput, signal?: AbortSignal): Promise<ProbeReport> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? 15_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const runProbe = async (stream: boolean): Promise<ProbeResult> => {
      const request: ModelInput = {
        ...input,
        maxResponseBytes: 65_536,
        stream,
        messages: [
          {
            role: 'user',
            content: stream ? 'Reply with OK.' : 'Call openbot_probe with ok set to true.',
          },
        ],
        ...(!stream
          ? {
              tools: [
                {
                  name: 'openbot_probe',
                  description: 'Check structured action support.',
                  parameters: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok'],
                    additionalProperties: false,
                  },
                },
              ],
              toolChoice: 'openbot_probe',
            }
          : {}),
      };
      const result = await this.adapter.generate(request, controller.signal);
      const succeeded =
        !result.error &&
        (stream
          ? result.events.some((event) => event.type === 'text' && Boolean(event.text.trim())) &&
            result.events.some(
              (event) =>
                event.type === 'complete' && ['stop', 'end_turn'].includes(event.stopReason),
            )
          : result.events.some(
              (event) =>
                event.type === 'action' &&
                event.name === 'openbot_probe' &&
                event.arguments.ok === true &&
                Object.keys(event.arguments).length === 1,
            ) &&
            result.events.some(
              (event) =>
                event.type === 'complete' && ['tool_calls', 'tool_use'].includes(event.stopReason),
            ));
      return {
        ok: succeeded,
        code: timedOut
          ? 'provider_timeout'
          : controller.signal.aborted
            ? 'provider_cancelled'
            : (result.error?.code ??
              (succeeded
                ? 'passed'
                : stream
                  ? 'provider_interrupted_stream'
                  : 'provider_action_unsupported')),
        raw: redactProviderText(result.raw, input),
      };
    };
    try {
      return {
        testedAt: (this.options.clock?.() ?? new Date()).toISOString(),
        text: await runProbe(true),
        action: await runProbe(false),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

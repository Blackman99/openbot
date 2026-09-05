import type { ProviderCredentials } from './secrets.js';
import type { ModelImage } from './vision-messages.js';

export type { ModelImage } from './vision-messages.js';
export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export interface ModelInput extends ProviderCredentials {
  baseUrl: string;
  modelId: string;
  anthropicVersion?: string;
  messages: {
    role: 'system' | 'user' | 'assistant';
    content: string;
    images?: readonly ModelImage[];
  }[];
  stream: boolean;
  tools?: { name: string; description?: string; parameters: Record<string, unknown> }[];
  toolChoice?: string;
  maxOutputTokens?: number;
  /** Internal bounded wire budget; diagnostics remain limited to 65,536 bytes. */
  maxResponseBytes?: number;
}
export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'action'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'complete'; stopReason: string };
export interface ModelFailure {
  code: string;
  category: 'retryable' | 'non_retryable' | 'unsupported_capability';
}
export interface ModelResponse {
  events: ModelEvent[];
  raw: string;
  error?: ModelFailure;
}
export type ModelEventConsumer = (event: ModelEvent) => void | Promise<void>;
export interface ModelAdapter {
  generate(
    input: ModelInput,
    signal?: AbortSignal,
    onEvent?: ModelEventConsumer,
  ): Promise<ModelResponse>;
}
export interface ModelDecoder {
  feed(chunk: string): ModelEvent[];
  finish(raw: string): ModelEvent[];
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

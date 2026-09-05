import {
  CAPABILITY_FLAGS,
  type CapabilityFlag,
  type RequiredCapability,
} from './capability-policy.js';
import { ProviderError } from './url-policy.js';

export function policyMutation(
  value: unknown,
  keys: string[],
): Record<string, unknown> & { expectedRevision: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('invalid_capability_policy');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(input, key)) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 0
  )
    throw new ProviderError('invalid_capability_policy');
  return input as Record<string, unknown> & { expectedRevision: number };
}
export function parseOverride(value: unknown) {
  const input = policyMutation(value, ['expectedRevision', 'capability', 'value', 'rationale']);
  if (
    !CAPABILITY_FLAGS.some((flag) => flag === input.capability) ||
    typeof input.value !== 'boolean' ||
    typeof input.rationale !== 'string' ||
    !input.rationale.trim() ||
    input.rationale.trim().length > 500
  )
    throw new ProviderError('invalid_capability_policy');
  return {
    expectedRevision: input.expectedRevision,
    capability: input.capability as CapabilityFlag,
    value: input.value,
    rationale: input.rationale.trim(),
  };
}
export type PolicyChange =
  | { kind: 'fallbacks'; requiredCapability: RequiredCapability; connectionIds: string[] }
  | {
      kind: 'override';
      capability: CapabilityFlag;
      value: boolean;
      rationale: string;
      createdAt: string;
    };

export function parseRequirement(value: unknown): RequiredCapability {
  if (value !== 'basic' && value !== 'collaboration' && value !== 'visionInput')
    throw new ProviderError('invalid_capability_policy');
  return value;
}
export function parseFallbacks(value: unknown) {
  const input = policyMutation(value, ['expectedRevision', 'requiredCapability', 'connectionIds']);
  const requiredCapability = parseRequirement(input.requiredCapability);
  if (
    !Array.isArray(input.connectionIds) ||
    input.connectionIds.length > 16 ||
    !input.connectionIds.every(
      (id) =>
        typeof id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id),
    )
  )
    throw new ProviderError('invalid_capability_policy');
  const connectionIds: string[] = input.connectionIds.map((id: string) => id.toLowerCase());
  if (new Set(connectionIds).size !== connectionIds.length)
    throw new ProviderError('duplicate_fallback');
  return { expectedRevision: input.expectedRevision, requiredCapability, connectionIds };
}

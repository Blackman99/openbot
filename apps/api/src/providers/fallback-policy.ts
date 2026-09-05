import {
  currentPolicy,
  policyDetails,
  type RequiredCapability,
  type CapabilityRecord,
} from './capability-policy.js';
import type { ConnectionRecord } from './connections.js';
import { ProviderError } from './url-policy.js';

export type ExclusionReason =
  'disabled' | 'capability_unknown' | 'capability_unsupported' | 'not_accessible';
export function capabilityExclusion(
  record: CapabilityRecord,
  required: RequiredCapability,
): ExclusionReason | null {
  if (!record.metadata.enabled) return 'disabled';
  const catalog = policyDetails(record);
  const basic = [catalog.flags.text.status, catalog.flags.streaming.status];
  if (basic.includes('unsupported')) return 'capability_unsupported';
  if (basic.includes('unknown')) return 'capability_unknown';
  if (required === 'basic') return null;
  const requiredFlags =
    required === 'visionInput'
      ? [catalog.flags.visionInput.status]
      : [catalog.flags.toolCalling.status, catalog.flags.structuredOutput.status];
  if (requiredFlags.includes('supported')) return null;
  return requiredFlags.includes('unknown') ? 'capability_unknown' : 'capability_unsupported';
}
export function validateFallbacks(
  records: ConnectionRecord[],
  primaryId: string,
  required: RequiredCapability,
  ids: string[],
): void {
  const graph = new Map(records.map((record) => [record.metadata.id.toLowerCase(), record]));
  for (const id of ids) {
    const target = graph.get(id);
    if (!target || !target.metadata.enabled) throw new ProviderError('fallback_unavailable');
    if (capabilityExclusion(target, required))
      throw new ProviderError('fallback_capability_required');
  }
  const edges = (id: string) =>
    id === primaryId ? ids : currentPolicy(graph.get(id)?.policy).fallbacks.connectionIds;
  const state = new Map<string, 'visiting' | 'done'>();
  for (const start of graph.keys()) {
    if (state.has(start)) continue;
    const stack = [{ id: start, index: 0 }];
    state.set(start, 'visiting');
    while (stack.length) {
      const node = stack.at(-1)!;
      const next = edges(node.id)[node.index++];
      if (next === undefined) {
        state.set(node.id, 'done');
        stack.pop();
        continue;
      }
      if (state.get(next) === 'visiting') throw new ProviderError('fallback_cycle');
      if (!state.has(next) && graph.has(next)) {
        state.set(next, 'visiting');
        stack.push({ id: next, index: 0 });
      }
    }
  }
}
export interface ResolutionCandidate {
  id: string;
  eligible: boolean;
  reason: ExclusionReason | null;
  name?: string;
  protocol?: ConnectionRecord['metadata']['protocol'];
  modelId?: string;
  revision?: number;
  basic?: boolean;
  collaboration?: boolean;
}
export function resolutionPreview(
  records: ConnectionRecord[],
  primaryId: string,
  requiredCapability: RequiredCapability,
) {
  const graph = new Map(records.map((record) => [record.metadata.id.toLowerCase(), record]));
  const canonicalId = primaryId.toLowerCase();
  if (!graph.has(canonicalId)) throw new ProviderError('connection_not_found');
  const candidates: ResolutionCandidate[] = [];
  const visited = new Set<string>();
  const stack = [canonicalId];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const record = graph.get(id);
    if (!record) {
      candidates.push({ id, eligible: false, reason: 'not_accessible' });
      continue;
    }
    const detail = policyDetails(record);
    const reason = capabilityExclusion(record, requiredCapability);
    candidates.push({
      id,
      eligible: reason === null,
      reason,
      name: detail.name,
      protocol: detail.protocol,
      modelId: detail.modelId,
      revision: detail.revision,
      basic: detail.basic,
      collaboration: detail.collaboration,
    });
    stack.push(...[...currentPolicy(record.policy).fallbacks.connectionIds].reverse());
  }
  const order = candidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => candidate.id);
  return {
    primaryId: canonicalId,
    requiredCapability,
    selectedId: order[0] ?? null,
    order,
    candidates,
  };
}

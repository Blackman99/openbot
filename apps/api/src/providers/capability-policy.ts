import type { ConnectionRecord } from './connections.js';
import type { ProbeReport } from './model-probe.js';

export const CAPABILITY_FLAGS = [
  'text',
  'streaming',
  'toolCalling',
  'structuredOutput',
  'visionInput',
] as const;
export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
export type RequiredCapability = 'basic' | 'collaboration' | 'visionInput';
export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export interface ProbeEvidence {
  status: CapabilityStatus;
  evidence: string;
  testedAt: string;
  actorUserId: string;
  generation: number;
}
export interface ManualCapabilityOverride {
  value: boolean;
  rationale: string;
  actorUserId: string;
  createdAt: string;
  generation: number;
}
export interface ModelPolicy {
  generation: number;
  probes: Partial<Record<CapabilityFlag, ProbeEvidence>>;
  overrides: Partial<Record<CapabilityFlag, ManualCapabilityOverride>>;
  fallbacks: { requiredCapability: RequiredCapability; connectionIds: string[] };
}
export function emptyPolicy(): ModelPolicy {
  return {
    generation: 0,
    probes: {},
    overrides: {},
    fallbacks: { requiredCapability: 'basic', connectionIds: [] },
  };
}
export function currentPolicy(policy?: ModelPolicy | null): ModelPolicy {
  return policy && Number.isSafeInteger(policy.generation) ? policy : emptyPolicy();
}
export function recordProbe(
  policy: ModelPolicy,
  actorUserId: string,
  report: ProbeReport,
): ModelPolicy {
  const proof = (result: ProbeReport['text']): ProbeEvidence => ({
    status: result.ok && result.code === 'passed' ? 'supported' : 'unsupported',
    evidence: result.code,
    testedAt: report.testedAt,
    actorUserId,
    generation: policy.generation,
  });
  return {
    ...policy,
    probes: {
      text: proof(report.text),
      streaming: proof(report.text),
      toolCalling: proof(report.action),
    },
  };
}
export interface EffectiveCapability {
  status: CapabilityStatus;
  source: 'probe' | 'manual' | 'unknown';
  evidence: string;
  actorUserId: string | null;
  observedAt: string | null;
  lastProbedAt: string | null;
  manualBadge: boolean;
  override?: ManualCapabilityOverride & { active: boolean };
}
export function capabilityFlags(policy: ModelPolicy): Record<CapabilityFlag, EffectiveCapability> {
  const flag = (name: CapabilityFlag): EffectiveCapability => {
    const probe =
      policy.probes[name]?.generation === policy.generation ? policy.probes[name] : undefined;
    const override = policy.overrides[name];
    const active = override?.generation === policy.generation;
    return {
      status: active
        ? override.value
          ? 'supported'
          : 'unsupported'
        : (probe?.status ?? 'unknown'),
      source: active ? 'manual' : probe ? 'probe' : 'unknown',
      evidence: active ? override.rationale : (probe?.evidence ?? 'not_probed'),
      actorUserId: active ? override.actorUserId : (probe?.actorUserId ?? null),
      observedAt: active ? override.createdAt : (probe?.testedAt ?? null),
      lastProbedAt: probe?.testedAt ?? null,
      manualBadge: Boolean(override),
      ...(override ? { override: { ...override, active } } : {}),
    };
  };
  return {
    text: flag('text'),
    streaming: flag('streaming'),
    toolCalling: flag('toolCalling'),
    structuredOutput: flag('structuredOutput'),
    visionInput: flag('visionInput'),
  };
}
export type CapabilityRecord = Pick<
  ConnectionRecord,
  'metadata' | 'revision' | 'policy' | 'canManage'
>;
export function policyDetails(record: CapabilityRecord) {
  const policy = currentPolicy(record.policy);
  const flags = capabilityFlags(policy);
  const basic = flags.text.status === 'supported' && flags.streaming.status === 'supported';
  return {
    id: record.metadata.id,
    name: record.metadata.name,
    protocol: record.metadata.protocol,
    modelId: record.metadata.modelId,
    enabled: record.metadata.enabled,
    canManage: record.canManage,
    revision: record.revision,
    generation: policy.generation,
    basic,
    collaboration:
      basic &&
      (flags.toolCalling.status === 'supported' || flags.structuredOutput.status === 'supported'),
    enhanced: { visionInput: flags.visionInput.status === 'supported' },
    flags,
    lastProbedAt: flags.text.lastProbedAt,
    fallbacks: policy.fallbacks,
  };
}

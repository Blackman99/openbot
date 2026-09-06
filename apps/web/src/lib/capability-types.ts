export const capabilityFlags = [
  'text',
  'streaming',
  'toolCalling',
  'structuredOutput',
  'visionInput',
] as const;
export type CapabilityFlag = (typeof capabilityFlags)[number];
export type RequiredCapability = 'basic' | 'collaboration' | 'visionInput';
export type ModelProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export interface CapabilityEvidence {
  status: 'supported' | 'unsupported' | 'unknown';
  source: 'probe' | 'manual' | 'unknown';
  evidence: string;
  actorUserId: string | null;
  observedAt: string | null;
  lastProbedAt: string | null;
  manualBadge: boolean;
  override?: {
    value: boolean;
    rationale: string;
    actorUserId: string;
    createdAt: string;
    generation: number;
    active: boolean;
  };
}
export interface CapabilityCatalog {
  id: string;
  name: string;
  protocol: ModelProtocol;
  modelId: string;
  enabled: boolean;
  canManage: boolean;
  revision: number;
  generation: number;
  basic: boolean;
  collaboration: boolean;
  enhanced: { visionInput: boolean };
  flags: Record<CapabilityFlag, CapabilityEvidence>;
  lastProbedAt: string | null;
  fallbacks: { requiredCapability: RequiredCapability; connectionIds: string[] };
}
export interface ResolutionCandidate {
  id: string;
  eligible: boolean;
  reason: null | 'disabled' | 'capability_unknown' | 'capability_unsupported' | 'not_accessible';
  name?: string;
  protocol?: ModelProtocol;
  modelId?: string;
  revision?: number;
  basic?: boolean;
  collaboration?: boolean;
}
export interface ResolutionPreview {
  primaryId: string;
  requiredCapability: RequiredCapability;
  selectedId: string | null;
  order: string[];
  candidates: ResolutionCandidate[];
}
export interface ModelChoice {
  id: string;
  name: string;
  enabled: boolean;
}

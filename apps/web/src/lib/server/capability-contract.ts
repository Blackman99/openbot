import {
  capabilityFlags,
  type CapabilityCatalog,
  type CapabilityEvidence,
  type ModelProtocol,
  type RequiredCapability,
  type ResolutionPreview,
  type ResolutionCandidate,
} from '../capability-types.js';
export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function date(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function nullableDate(value: unknown): boolean {
  return value === null || date(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty) && new Set(value).size === value.length;
}
function protocol(value: unknown): value is ModelProtocol {
  return value === 'openai-chat' || value === 'openai-responses' || value === 'anthropic-messages';
}
export function requirement(value: unknown): value is RequiredCapability {
  return value === 'basic' || value === 'collaboration' || value === 'visionInput';
}
function evidence(value: unknown): value is CapabilityEvidence {
  if (
    !record(value) ||
    !keys(
      value,
      ['status', 'source', 'evidence', 'actorUserId', 'observedAt', 'lastProbedAt', 'manualBadge'],
      ['override'],
    )
  )
    return false;
  if (
    typeof value.status !== 'string' ||
    !['supported', 'unsupported', 'unknown'].includes(value.status) ||
    typeof value.source !== 'string' ||
    !['probe', 'manual', 'unknown'].includes(value.source) ||
    typeof value.evidence !== 'string' ||
    !(value.actorUserId === null || nonempty(value.actorUserId)) ||
    !nullableDate(value.observedAt) ||
    !nullableDate(value.lastProbedAt) ||
    typeof value.manualBadge !== 'boolean'
  )
    return false;
  const override = value.override;
  if (
    override !== undefined &&
    (!record(override) ||
      !keys(override, ['value', 'rationale', 'actorUserId', 'createdAt', 'generation', 'active']) ||
      typeof override.value !== 'boolean' ||
      !nonempty(override.rationale) ||
      !nonempty(override.actorUserId) ||
      !date(override.createdAt) ||
      !integer(override.generation) ||
      typeof override.active !== 'boolean')
  )
    return false;
  if (value.manualBadge !== (override !== undefined)) return false;
  if (value.source === 'manual')
    return (
      record(override) &&
      override.active === true &&
      value.status === (override.value ? 'supported' : 'unsupported') &&
      value.evidence === override.rationale &&
      value.actorUserId === override.actorUserId &&
      value.observedAt === override.createdAt
    );
  if (record(override) && override.active) return false;
  if (value.source === 'probe')
    return (
      value.status !== 'unknown' &&
      nonempty(value.actorUserId) &&
      date(value.observedAt) &&
      date(value.lastProbedAt)
    );
  return (
    value.status === 'unknown' &&
    value.actorUserId === null &&
    value.observedAt === null &&
    value.lastProbedAt === null
  );
}
export function catalog(value: unknown): value is CapabilityCatalog {
  if (
    !record(value) ||
    !keys(value, [
      'id',
      'name',
      'protocol',
      'modelId',
      'enabled',
      'canManage',
      'revision',
      'generation',
      'basic',
      'collaboration',
      'enhanced',
      'flags',
      'lastProbedAt',
      'fallbacks',
    ])
  )
    return false;
  if (
    !['id', 'name', 'modelId'].every((key) => nonempty(value[key])) ||
    !protocol(value.protocol) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.canManage !== 'boolean' ||
    !integer(value.revision) ||
    !integer(value.generation) ||
    typeof value.basic !== 'boolean' ||
    typeof value.collaboration !== 'boolean' ||
    !nullableDate(value.lastProbedAt)
  )
    return false;
  if (
    !record(value.flags) ||
    !keys(value.flags, capabilityFlags) ||
    !capabilityFlags.every((flag) => evidence((value.flags as Record<string, unknown>)[flag]))
  )
    return false;
  if (
    !record(value.enhanced) ||
    !keys(value.enhanced, ['visionInput']) ||
    typeof value.enhanced.visionInput !== 'boolean' ||
    !record(value.fallbacks) ||
    !keys(value.fallbacks, ['requiredCapability', 'connectionIds']) ||
    !requirement(value.fallbacks.requiredCapability) ||
    !ids(value.fallbacks.connectionIds) ||
    value.fallbacks.connectionIds.length > 16
  )
    return false;
  const flags = value.flags as Record<(typeof capabilityFlags)[number], CapabilityEvidence>;
  if (
    !capabilityFlags.every(
      (flag) =>
        !flags[flag].override ||
        (flags[flag].override.generation <= Number(value.generation) &&
          flags[flag].override.active === (flags[flag].override.generation === value.generation)),
    )
  )
    return false;
  const basic = flags.text.status === 'supported' && flags.streaming.status === 'supported';
  return (
    value.basic === basic &&
    value.collaboration ===
      (basic &&
        (flags.toolCalling.status === 'supported' ||
          flags.structuredOutput.status === 'supported')) &&
    value.enhanced.visionInput === (flags.visionInput.status === 'supported')
  );
}

function candidate(value: unknown): value is ResolutionCandidate {
  if (
    !record(value) ||
    !keys(
      value,
      ['id', 'eligible', 'reason'],
      ['name', 'protocol', 'modelId', 'revision', 'basic', 'collaboration'],
    ) ||
    !nonempty(value.id) ||
    typeof value.eligible !== 'boolean'
  )
    return false;
  if (
    value.reason !== null &&
    !['disabled', 'capability_unknown', 'capability_unsupported', 'not_accessible'].includes(
      String(value.reason),
    )
  )
    return false;
  if (value.reason !== null && typeof value.reason !== 'string') return false;
  if (value.eligible !== (value.reason === null)) return false;
  if (value.reason === 'not_accessible') return keys(value, ['id', 'eligible', 'reason']);
  return (
    ['name', 'modelId'].every((key) => value[key] === undefined || nonempty(value[key])) &&
    (value.protocol === undefined || protocol(value.protocol)) &&
    (value.revision === undefined || integer(value.revision)) &&
    ['basic', 'collaboration'].every(
      (key) => value[key] === undefined || typeof value[key] === 'boolean',
    )
  );
}
export function preview(value: unknown): value is ResolutionPreview {
  if (
    !record(value) ||
    !keys(value, ['primaryId', 'requiredCapability', 'selectedId', 'order', 'candidates']) ||
    !nonempty(value.primaryId) ||
    !requirement(value.requiredCapability) ||
    !ids(value.order) ||
    !Array.isArray(value.candidates) ||
    !value.candidates.every(candidate)
  )
    return false;
  const candidates = value.candidates;
  const eligible = candidates.filter((item) => item.eligible).map((item) => item.id);
  return (
    candidates[0]?.id === value.primaryId &&
    new Set(candidates.map((item) => item.id)).size === candidates.length &&
    value.order.length === eligible.length &&
    value.order.every((id, index) => id === eligible[index]) &&
    value.selectedId === (eligible[0] ?? null)
  );
}

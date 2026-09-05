export interface GroupRoutingSetting {
  groupId: string;
  revision: number;
  canManage: boolean;
  defaultLead: null | {
    grantId: string;
    bot: { id: string; name: string; roleDescription: string };
    closed: boolean;
  };
}
export interface GroupRoutingCommand {
  expectedRevision: number;
  defaultGrantId: string | null;
}
export interface RoutingSummary {
  algorithm: 'local-terms-v1';
  reason: 'mention' | 'default' | 'local-match';
}
export interface RoutingCandidate {
  botId: string;
  grantId: string;
  versionId: string;
  name: string;
  roleDescription: string;
  description: string;
}
export interface RoutingEvidence extends RoutingCandidate {
  score: number;
  matchedTerms: string[];
}
export interface RoutingDecision extends RoutingSummary {
  lead: RoutingCandidate;
  candidates: RoutingEvidence[];
}
export function parseRoutingSummary(value: unknown): RoutingSummary | undefined {
  if (
    !routingKeys(value, 'algorithm,reason') ||
    value.algorithm !== 'local-terms-v1' ||
    (value.reason !== 'mention' && value.reason !== 'default' && value.reason !== 'local-match')
  )
    return undefined;
  return { algorithm: value.algorithm, reason: value.reason };
}
function persona(value: Record<string, unknown>): RoutingCandidate | undefined {
  if (
    !routingUuid(value.botId) ||
    !routingUuid(value.grantId) ||
    !routingUuid(value.versionId) ||
    !text(value.name, 100) ||
    !text(value.roleDescription, 200) ||
    !text(value.description, 2000, true)
  )
    return undefined;
  return {
    botId: value.botId.toLowerCase(),
    grantId: value.grantId.toLowerCase(),
    versionId: value.versionId.toLowerCase(),
    name: value.name,
    roleDescription: value.roleDescription,
    description: value.description,
  };
}
// This is the local-terms-v1 receipt grammar, not a new routing or admission decision.
// NFKC can expand a public field, so the field's actual term set bounds the evidence.
function publicTerms(value: string): Set<string> {
  const found = new Set<string>();
  const words = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Script=Han}+/gu, (run) => {
      const characters = [...run];
      if (characters.length === 1) found.add(run);
      for (let i = 1; i < characters.length; i++) found.add(characters[i - 1]! + characters[i]!);
      return ' ';
    });
  for (const word of words.match(/[\p{L}\p{N}]+/gu) ?? []) found.add(word);
  return found;
}
export function parseRoutingDecision(value: unknown): RoutingDecision | undefined {
  if (
    !routingKeys(value, 'algorithm,candidates,lead,reason') ||
    !routingKeys(value.lead, 'botId,description,grantId,name,roleDescription,versionId') ||
    !Array.isArray(value.candidates) ||
    value.candidates.length < 1 ||
    value.candidates.length > 8
  )
    return undefined;
  const summary = parseRoutingSummary({ algorithm: value.algorithm, reason: value.reason });
  const lead = persona(value.lead);
  if (!summary || !lead) return undefined;
  const candidates: RoutingEvidence[] = [];
  const grantIds = new Set<string>(),
    versionIds = new Set<string>();
  for (const row of value.candidates) {
    if (
      !routingKeys(
        row,
        'botId,description,grantId,matchedTerms,name,roleDescription,score,versionId',
      ) ||
      typeof row.score !== 'number' ||
      !Number.isSafeInteger(row.score) ||
      row.score < 0 ||
      !Array.isArray(row.matchedTerms)
    )
      return undefined;
    const candidate = persona(row);
    if (
      !candidate ||
      (candidates.at(-1)?.botId ?? '') >= candidate.botId ||
      grantIds.has(candidate.grantId) ||
      versionIds.has(candidate.versionId)
    )
      return undefined;
    const weights = new Map<string, number>();
    for (const [field, weight] of [
      [candidate.name, 3],
      [candidate.roleDescription, 4],
      [candidate.description, 1],
    ] as const)
      for (const term of publicTerms(field)) weights.set(term, (weights.get(term) ?? 0) + weight);
    if (row.matchedTerms.length > weights.size) return undefined;
    const matchedTerms: string[] = [];
    let score = 0;
    for (const term of row.matchedTerms) {
      if (typeof term !== 'string' || !weights.has(term) || (matchedTerms.at(-1) ?? '') >= term)
        return undefined;
      score += weights.get(term)!;
      matchedTerms.push(term);
    }
    if (row.score !== score) return undefined;
    candidates.push({ ...candidate, score, matchedTerms });
    grantIds.add(candidate.grantId);
    versionIds.add(candidate.versionId);
  }
  const selected = candidates.find((candidate) => candidate.botId === lead.botId);
  if (
    !selected ||
    selected.grantId !== lead.grantId ||
    selected.versionId !== lead.versionId ||
    selected.name !== lead.name ||
    selected.roleDescription !== lead.roleDescription ||
    selected.description !== lead.description
  )
    return undefined;
  if (
    summary.reason === 'local-match' &&
    candidates.some(
      (candidate) =>
        candidate.score > selected.score ||
        (candidate.score === selected.score && candidate.botId < selected.botId),
    )
  )
    return undefined;
  return { ...summary, lead, candidates };
}
export function routingKeys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
export function routingUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
function text(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === 'string' && (empty || Boolean(value.trim())) && value.length <= maximum;
}
export function parseGroupRoutingCommand(value: unknown): GroupRoutingCommand | undefined {
  if (
    !routingKeys(value, 'defaultGrantId,expectedRevision') ||
    typeof value.expectedRevision !== 'number' ||
    !Number.isInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    value.expectedRevision >= 2147483647 ||
    (value.defaultGrantId !== null && !routingUuid(value.defaultGrantId))
  )
    return undefined;
  return {
    expectedRevision: value.expectedRevision,
    defaultGrantId: value.defaultGrantId?.toLowerCase() ?? null,
  };
}
export function parseGroupRoutingSetting(
  value: unknown,
  groupId: string,
): GroupRoutingSetting | undefined {
  if (
    !routingKeys(value, 'canManage,defaultLead,groupId,revision') ||
    !routingUuid(value.groupId) ||
    value.groupId.toLowerCase() !== groupId.toLowerCase() ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    value.revision > 2147483647 ||
    typeof value.canManage !== 'boolean'
  )
    return undefined;
  let defaultLead: GroupRoutingSetting['defaultLead'] = null;
  if (value.defaultLead !== null) {
    const lead = value.defaultLead;
    if (
      value.revision === 0 ||
      !routingKeys(lead, 'bot,closed,grantId') ||
      !routingUuid(lead.grantId) ||
      typeof lead.closed !== 'boolean' ||
      !routingKeys(lead.bot, 'id,name,roleDescription') ||
      !routingUuid(lead.bot.id) ||
      !text(lead.bot.name, 100) ||
      !text(lead.bot.roleDescription, 200)
    )
      return undefined;
    defaultLead = {
      grantId: lead.grantId.toLowerCase(),
      closed: lead.closed,
      bot: {
        id: lead.bot.id.toLowerCase(),
        name: lead.bot.name,
        roleDescription: lead.bot.roleDescription,
      },
    };
  }
  return {
    groupId: value.groupId.toLowerCase(),
    revision: value.revision,
    canManage: value.canManage,
    defaultLead,
  };
}

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

export type RoutingDecision = ReturnType<typeof chooseLead>;
export type RoutingSummary = Pick<RoutingDecision, 'algorithm' | 'reason'>;

export class RoutingSelectionError extends Error {
  constructor(readonly code: 'mentioned_bot_unavailable' | 'no_eligible_bot') {
    super(code);
  }
}

function terms(text: string): Set<string> {
  const result = new Set<string>();
  const remaining = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Script=Han}+/gu, (run) => {
      const characters = [...run];
      if (characters.length === 1) result.add(run);
      for (let index = 1; index < characters.length; index++)
        result.add(characters[index - 1]! + characters[index]!);
      return ' ';
    });
  for (const word of remaining.match(/[\p{L}\p{N}]+/gu) ?? []) result.add(word);
  return result;
}

function persona(candidate: RoutingCandidate): RoutingCandidate {
  return {
    botId: candidate.botId,
    grantId: candidate.grantId,
    versionId: candidate.versionId,
    name: candidate.name,
    roleDescription: candidate.roleDescription,
    description: candidate.description,
  };
}

// Candidates are already admitted by the transaction-owned group/model selector.
// Matching uses only public persona fields, never instructions or provider I/O.
export function chooseLead(input: {
  body: string;
  mentionedGrantId?: string;
  defaultGrantId?: string | null;
  candidates: readonly RoutingCandidate[];
}) {
  const query = terms(input.body);
  const candidates: RoutingEvidence[] = input.candidates.map((candidate) => {
    const matches = new Set<string>();
    let score = 0;
    for (const [field, weight] of [
      [candidate.name, 3],
      [candidate.roleDescription, 4],
      [candidate.description, 1],
    ] as const) {
      for (const term of terms(field)) {
        if (query.has(term)) {
          score += weight;
          matches.add(term);
        }
      }
    }
    return { ...persona(candidate), score, matchedTerms: [...matches].sort() };
  });
  candidates.sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0));
  let reason: 'mention' | 'default' | 'local-match' = input.mentionedGrantId
    ? 'mention'
    : 'default';
  const target = input.mentionedGrantId ?? input.defaultGrantId;
  let lead = input.candidates.find((candidate) => candidate.grantId === target);
  if (!lead && !input.mentionedGrantId) {
    reason = 'local-match';
    const winner = [...candidates].sort((a, b) => b.score - a.score)[0];
    lead = input.candidates.find((candidate) => candidate.grantId === winner?.grantId);
  }
  if (!lead)
    throw new RoutingSelectionError(
      input.mentionedGrantId ? 'mentioned_bot_unavailable' : 'no_eligible_bot',
    );
  return { algorithm: 'local-terms-v1' as const, reason, lead: persona(lead), candidates };
}

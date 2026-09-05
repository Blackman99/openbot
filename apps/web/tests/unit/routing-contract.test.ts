import { describe, expect, it } from 'vitest';
import { parseRoutingDecision } from '../../src/lib/routing-contract.js';
import { decision, lead, other } from '../fixtures/routing.js';
describe('Historical routing decision projection', () => {
  it('projects the pinned public lead and every admitted candidate with lexical evidence', () => {
    expect(parseRoutingDecision(decision)).toEqual(decision);
    const result = parseRoutingDecision(decision)!;
    result.candidates[0]!.matchedTerms.push('cannot-mutate-receipt');
    expect(decision.candidates[0]!.matchedTerms).toEqual(['evidence', 'research']);
  });
  it.each(['mention', 'default'] as const)(
    'keeps %s precedence even when the chosen candidate has a lower score',
    (reason) => {
      const value = { ...decision, reason, lead: other };
      expect(parseRoutingDecision(value)).toEqual(value);
    },
  );
  it('accepts zero-score UUID ties and NFKC/Han evidence with weights accumulated across fields', () => {
    const zero = {
      ...decision,
      candidates: decision.candidates.map((candidate) => ({
        ...candidate,
        score: 0,
        matchedTerms: [],
      })),
    };
    expect(parseRoutingDecision(zero)).toEqual(zero);
    const persona = {
      ...lead,
      name: 'ＡＩ 数据研究',
      roleDescription: 'AI 数据',
      description: '数据研究',
    };
    const han = {
      ...decision,
      lead: persona,
      candidates: [{ ...persona, score: 23, matchedTerms: ['ai', '据研', '数据', '研究'] }],
    };
    expect(parseRoutingDecision(han)).toEqual(han);
  });
  it.each([
    { ...decision, algorithm: 'remote-v1' },
    { ...decision, reason: 'confidence' },
    { ...decision, prompt: 'private' },
    { ...decision, lead: { ...lead, instructions: 'private' } },
    { ...decision, lead: { ...lead, versionId: other.versionId } },
    { ...decision, lead: { ...lead, name: 'Changed after submission' } },
    { ...decision, lead: other },
    { ...decision, candidates: [] },
    { ...decision, candidates: Array(9).fill(decision.candidates[0]) },
    { ...decision, candidates: [decision.candidates[1], decision.candidates[0]] },
    { ...decision, candidates: [decision.candidates[0], decision.candidates[0]] },
    {
      ...decision,
      candidates: [decision.candidates[0], { ...decision.candidates[1], grantId: lead.grantId }],
    },
    { ...decision, candidates: [{ ...decision.candidates[0], score: 4.5 }] },
    { ...decision, candidates: [{ ...decision.candidates[0], score: 6 }] },
    { ...decision, candidates: [{ ...decision.candidates[0], score: -1 }] },
    {
      ...decision,
      candidates: [{ ...decision.candidates[0], matchedTerms: ['research', 'evidence'] }],
    },
    {
      ...decision,
      candidates: [{ ...decision.candidates[0], matchedTerms: ['evidence', 'evidence'] }],
    },
    {
      ...decision,
      candidates: [{ ...decision.candidates[0], matchedTerms: ['private instructions'] }],
    },
    { ...decision, candidates: [{ ...decision.candidates[0], modelId: 'private' }] },
    { ...decision, candidates: [{ ...decision.candidates[0], description: 'x'.repeat(2001) }] },
  ])('rejects malformed, private or internally inconsistent evidence %#', (value) => {
    expect(parseRoutingDecision(value)).toBeUndefined();
  });
});

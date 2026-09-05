import { expect, it } from 'vitest';
import {
  chooseLead,
  RoutingSelectionError,
  type RoutingCandidate,
} from '../../src/routing/matcher.js';

const writer: RoutingCandidate = {
  botId: '00000000-0000-4000-8000-000000000001',
  grantId: '00000000-0000-4000-8000-000000000011',
  versionId: '00000000-0000-4000-8000-000000000021',
  name: 'Writer',
  roleDescription: 'Writing and editing',
  description: 'Clear product explanations',
};
const programmer: RoutingCandidate = {
  botId: '00000000-0000-4000-8000-000000000002',
  grantId: '00000000-0000-4000-8000-000000000012',
  versionId: '00000000-0000-4000-8000-000000000022',
  name: 'Engineer',
  roleDescription: 'Programming and software development',
  description: 'TypeScript and database queries',
};

it('selects an explicit mention ahead of the eligible default and stronger matching evidence', () => {
  const decision = chooseLead({
    body: 'Please write TypeScript software',
    mentionedGrantId: writer.grantId,
    defaultGrantId: programmer.grantId,
    candidates: [programmer, writer],
  });
  expect(decision.reason).toBe('mention');
  expect(decision.lead).toEqual(writer);
  expect(decision.algorithm).toBe('local-terms-v1');
  expect(decision.candidates.map((candidate) => candidate.grantId)).toEqual([
    writer.grantId,
    programmer.grantId,
  ]);
  expect(decision.candidates[1]!.score).toBeGreaterThan(decision.candidates[0]!.score);
});

it('uses an eligible configured default when no Bot was mentioned', () => {
  const decision = chooseLead({
    body: 'TypeScript software and database queries',
    defaultGrantId: writer.grantId,
    candidates: [writer, programmer],
  });
  expect(decision.reason).toBe('default');
  expect(decision.lead).toEqual(writer);
});

it('does not silently send an unavailable explicit mention to a different Bot', () => {
  expect(() =>
    chooseLead({
      body: 'Private question for the selected Bot',
      mentionedGrantId: writer.grantId,
      defaultGrantId: programmer.grantId,
      candidates: [programmer],
    }),
  ).toThrow(new RoutingSelectionError('mentioned_bot_unavailable'));
});

it('uses local persona evidence when no eligible default remains, independent of candidate order', () => {
  const input = { body: 'TypeScript software', defaultGrantId: 'removed-grant' };
  const decision = chooseLead({ ...input, candidates: [writer, programmer] });
  expect(decision.reason).toBe('local-match');
  expect(decision.lead).toEqual(programmer);
  expect(decision.candidates[1]!.matchedTerms).toEqual(['software', 'typescript']);
  expect(chooseLead({ ...input, candidates: [programmer, writer] })).toEqual(decision);
  expect(
    chooseLead({
      ...input,
      body: 'TypeScript TypeScript software software',
      candidates: [programmer, writer],
    }),
  ).toEqual(decision);
});

it('breaks empty-evidence ties by stable Bot identity, not membership enumeration', () => {
  const decision = chooseLead({ body: 'Hello!', candidates: [programmer, writer] });
  expect(decision.reason).toBe('local-match');
  expect(decision.lead).toEqual(writer);
  expect(decision.candidates.map((candidate) => candidate.score)).toEqual([0, 0]);
});

it('reports an empty admitted candidate set without selecting an arbitrary target', () => {
  expect(() => chooseLead({ body: 'Hello', candidates: [] })).toThrow(
    new RoutingSelectionError('no_eligible_bot'),
  );
});

it('matches normalized Latin words and local Han bigrams without a provider request', () => {
  expect(
    chooseLead({ body: 'ＴＹＰＥＳＣＲＩＰＴ', candidates: [writer, programmer] }).lead,
  ).toEqual(programmer);
  const chineseProgrammer = {
    ...programmer,
    name: '开发者',
    roleDescription: '编程与数据库设计',
    description: '',
  };
  const chineseWriter = { ...writer, name: '写作者', roleDescription: '产品写作', description: '' };
  const decision = chooseLead({
    body: '请协助设计数据库',
    candidates: [chineseWriter, chineseProgrammer],
  });
  expect(decision.lead).toEqual(chineseProgrammer);
  expect(decision.candidates[1]!.matchedTerms).toEqual(['据库', '数据', '设计']);
});

it('projects safe persona fields and detached evidence even when the caller holds private configuration', () => {
  const configured = {
    ...programmer,
    instructions: 'Never serialize these instructions',
    modelBinding: { connectionId: 'private' },
  };
  const decision = chooseLead({
    body: 'TypeScript',
    candidates: [configured],
    mentionedGrantId: programmer.grantId,
  });
  expect(decision.lead).toEqual(programmer);
  expect(decision.candidates[0]).not.toHaveProperty('instructions');
  expect(decision.candidates[0]).not.toHaveProperty('modelBinding');
  configured.name = 'Changed after selection';
  expect(decision.lead.name).toBe('Engineer');
  expect(decision.candidates[0]!.name).toBe('Engineer');
});

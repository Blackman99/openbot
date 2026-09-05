import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Settings from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/routing/+page.svelte';
import Decision from '../../src/lib/components/RoutingDecision.svelte';
import { decision, grant, group, setting, user, workspace } from '../fixtures/routing.js';
const params = { workspaceId: workspace.id, groupId: group.id };
const data = {
  user,
  workspace,
  workspaces: [workspace],
  group,
  routing: setting,
  candidates: [
    {
      grantId: grant.id,
      botId: grant.bot.id,
      name: grant.bot.name,
      roleDescription: grant.bot.roleDescription,
    },
  ],
};
describe('Group routing and historical decision views', () => {
  it('shows manager controls with exact grant choices and the displayed CAS revision', () => {
    const html = render(Settings, { props: { data, form: null, params } }).body;
    expect(html).toContain('Default Lead');
    expect(html).toContain('name="expectedRevision" value="3"');
    expect(html).toContain(`value="${grant.id}" selected`);
    expect(html).toContain('Save default');
    expect(html).toContain('Clear default');
    expect(html).toContain('action="?/update"');
  });
  it('keeps closed default identity visible without promoting a reinvited grant or granting member controls', () => {
    const closed = {
      ...setting,
      canManage: false,
      defaultLead: { ...setting.defaultLead, closed: true },
    };
    const html = render(Settings, {
      props: { data: { ...data, routing: closed, candidates: [] }, form: null, params },
    }).body;
    expect(html).toContain('Researcher');
    expect(html).toContain(grant.id);
    expect(html).toContain('Membership closed');
    expect(html).toContain('A new invitation does not replace this saved membership');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('/bots/');
  });
  it('does not silently choose a new grant when an old default has closed and still offers clearing', () => {
    const closed = { ...setting, defaultLead: { ...setting.defaultLead, closed: true } };
    const html = render(Settings, {
      props: {
        data: {
          ...data,
          routing: closed,
          candidates: [{ ...data.candidates[0]!, grantId: workspace.id }],
        },
        form: null,
        params,
      },
    }).body;
    expect(html).toMatch(
      new RegExp(`<option[^>]*value="${grant.id}"[^>]*disabled[^>]*selected[^>]*>`),
    );
    expect(html).not.toContain(`value="${workspace.id}" selected`);
    expect(html).toContain('Clear default');
  });
  it.each(['conflict', 'uncertain'] as const)(
    'retains original revision and blocks automatic overwriting after %s',
    (state) => {
      const form = {
        values: { expectedRevision: '2', defaultGrantId: grant.id },
        conflict: state === 'conflict',
        uncertain: state === 'uncertain',
        error: 'Refresh before changing again.',
      };
      const html = render(Settings, { props: { data, form, params } }).body;
      expect(html).toContain('name="expectedRevision" value="2"');
      expect(html).toMatch(/<button\b[^>]*disabled[^>]*>Save default/u);
      expect(html).toMatch(/<button\b[^>]*disabled[^>]*>Clear default/u);
      expect(html).toContain('Refresh settings');
      expect(html).toContain('role="alert"');
    },
  );
  it.each([
    ['mention', 'Explicit @ mention'],
    ['default', 'Group default'],
    ['local-match', 'Local term match'],
  ] as const)(
    'renders the chosen lead and %s reason with every candidate and expandable lexical evidence',
    (reason, label) => {
      const html = render(Decision, { props: { decision: { ...decision, reason } } }).body;
      expect(html).toContain('Lead: Researcher');
      expect(html).toContain(label);
      expect(html).toContain('<details');
      expect(html).toContain('Candidate evidence (2)');
      expect(html).toContain('Lexical score: 5');
      expect(html).toContain('Research assistant');
      expect(html).toContain('Find useful evidence');
      expect(html).toContain('evidence');
      expect(html).toContain('research');
      expect(html).toContain('Writer');
      expect(html).toContain('No matching terms');
      expect(html).toContain('not a confidence percentage');
      expect(html).not.toMatch(/<a\b/u);
    },
  );
  it('escapes public persona and matched-term content', () => {
    const html = render(Decision, {
      props: {
        decision: {
          ...decision,
          lead: { ...decision.lead, name: '<script>alert(1)</script>' },
          candidates: [
            {
              ...decision.candidates[0]!,
              description: '<img src=x onerror=alert(1)>',
              matchedTerms: ['<svg/onload=alert(1)>'],
            },
          ],
        },
      },
    }).body;
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;script');
    expect(html).toContain('&lt;img');
  });
});

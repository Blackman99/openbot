import { message } from '../fixtures/conversations.js';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Bots from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/bots/+page.svelte';
import Context from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/bots/[grantId]/context/+page.svelte';
import { group, grant, membership, user, workspace, summary } from '../fixtures/group-bots.js';
const data = {
  user,
  workspace,
  workspaces: [workspace],
  group,
  membership,
  candidates: [{ id: summary.id, name: summary.name, roleDescription: summary.roleDescription }],
  commands: { invite: 'invite-key', remove: { [grant.id]: 'remove-key' } },
};
describe('Group Bot pages', () => {
  it('shows explicit history choices with future-only default, provenance and separate inspect access', () => {
    const html = render(Bots, {
      props: { data, form: null, params: { workspaceId: workspace.id, groupId: group.id } },
    }).body;
    expect(html).toContain('Invite Bot');
    expect(html).toContain('value="future-only" selected');
    expect(html).toContain('Since an event');
    expect(html).toContain('Since a time');
    expect(html).toContain('All history');
    expect(html).toContain('Invited by Ada');
    expect(html).toContain('View Bot details');
    expect(html).toContain('View allowed context');
    expect(html).toContain('Remove Researcher');
  });
  it('keeps ordinary group members read-only with default avatars and no implicit Bot inspect link', () => {
    const html = render(Bots, {
      props: {
        data: {
          ...data,
          membership: {
            ...membership,
            canManage: false,
            grants: [{ ...grant, bot: { ...grant.bot, canInspect: false } }],
          },
          candidates: [],
        },
        form: null,
        params: { workspaceId: workspace.id, groupId: group.id },
      },
    }).body;
    expect(html).toContain('Default avatar for Researcher');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('View Bot details');
    expect(html).not.toContain('action="?/');
    expect(html).toContain('View allowed context');
  });
  it('renders an unchanged invitation retry even if its commit now fills the group', () => {
    const form = {
      action: 'invite' as const,
      values: { idempotencyKey: 'retained-key', botId: grant.bot.id, mode: 'all' },
      uncertain: true,
      conflict: false,
      error: 'Result could not be confirmed.',
    };
    const html = render(Bots, {
      props: {
        data: { ...data, membership: { ...membership, activeCount: 8 } },
        form,
        params: { workspaceId: workspace.id, groupId: group.id },
      },
    }).body;
    expect(html).toContain('Retry invitation unchanged');
    expect(html).toContain('value="retained-key"');
    expect(html).toContain('value="all"');
    expect(html).not.toContain('<select');
  });
  it('retains exact removal retry after an ambiguous commit closes the membership', () => {
    const closed = {
      ...grant,
      closed: {
        eventId: workspace.id,
        sequence: 5,
        at: group.createdAt,
        reason: 'removed' as const,
      },
    };
    const html = render(Bots, {
      props: {
        data: { ...data, membership: { ...membership, grants: [closed], activeCount: 0 } },
        form: {
          action: 'remove',
          values: { idempotencyKey: 'remove-same', grantId: grant.id },
          uncertain: true,
          conflict: false,
          error: 'Unknown result',
        },
        params: { workspaceId: workspace.id, groupId: group.id },
      },
    }).body;
    expect(html).toContain('Retry removal unchanged');
    expect(html).toContain('value="remove-same"');
    expect(html).not.toContain('View allowed context');
    expect(html).toContain('Reinvitation creates a separate history grant');
  });
  it('displays escaped current context with no editing/version controls and bounded-page navigation', () => {
    const html = render(Context, {
      props: {
        form: null,
        data: {
          user,
          workspace,
          workspaces: [workspace],
          group,
          grant,
          context: {
            grantId: grant.id,
            conversationId: grant.conversationId,
            messages: [
              {
                ...message,
                body: '<script>private text</script>',
                canEdit: false,
                canDelete: false,
                canAudit: false,
              },
            ],
            nextCursor: 'opaque_cursor',
          },
        },
        params: { workspaceId: workspace.id, groupId: group.id, grantId: grant.id },
      },
    }).body;
    expect(html).toContain('&lt;script>private text&lt;/script>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('View versions');
    expect(html).not.toContain('<form');
    expect(html).toContain('?cursor=opaque_cursor');
    expect(html).toContain('Read-only context');
  });
});

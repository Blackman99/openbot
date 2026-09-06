import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Lifecycle from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/lifecycle/+page.svelte';
import Recovery from '../../src/routes/app/workspaces/[workspaceId]/bots/deleted/+page.svelte';
import BotPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/+page.svelte';
import GroupBots from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/bots/+page.svelte';
import { bot, summary, user, workspace } from '../fixtures/bots.js';
import { group, grant, membership } from '../fixtures/group-bots.js';
const base = { user, workspace, workspaces: [workspace] };
const params = { workspaceId: workspace.id, botId: bot.id };
describe('lifecycle recovery UI', () => {
  it.each(['active', 'archived', 'deleted'] as const)(
    'renders %s with appropriate owner transitions and physical-erasure exclusion',
    (state) => {
      const lifecycle = {
        botId: bot.id,
        workspaceId: workspace.id,
        state,
        deletedAt: state === 'deleted' ? '2030-01-01T00:00:00.000Z' : null,
        recoveryDeadline: state === 'deleted' ? '2030-01-31T00:00:00.000Z' : null,
        preDeletedState: state === 'deleted' ? ('archived' as const) : null,
      };
      const html = render(Lifecycle, {
        props: {
          data: { ...base, bot: { id: bot.id, name: bot.name }, lifecycle },
          form: null,
          params,
        },
      }).body;
      expect(html).toContain(`Current state: ${state}`);
      expect(html).toContain('does not physically erase');
      expect(html).toContain(bot.id);
      expect(html).toContain(
        state === 'active' ? '?/archive' : state === 'archived' ? '?/restore' : '?/undoDelete',
      );
      if (state === 'deleted') {
        expect(html).toContain(lifecycle.recoveryDeadline);
        expect(html).not.toContain('action="?/restore"');
      }
    },
  );
  it('links owners to recovery and labels retained deleted identity without opening lifecycle management for editors', () => {
    const html = render(Recovery, {
      props: {
        data: { ...base, bots: [{ ...summary, lifecycleState: 'deleted' }] },
        form: null,
        params: { workspaceId: workspace.id },
      },
    }).body;
    expect(html).toContain(`/bots/${bot.id}/lifecycle`);
    expect(html).toContain('Deleted Bot');
    for (const accessRole of ['owner', 'editor'] as const) {
      const detail = render(BotPage, {
        props: {
          data: { ...base, bot: { ...bot, lifecycleState: 'deleted', accessRole } },
          form: null,
          params,
        },
      }).body;
      expect(detail).toContain('Deleted Bot · Historical identity retained');
      expect(detail.includes('Manage lifecycle')).toBe(accessRole === 'owner');
    }
  });
  it('retains group grant provenance and hides context-use links for a deleted Bot', () => {
    const html = render(GroupBots, {
      props: {
        data: {
          ...base,
          group,
          membership: {
            ...membership,
            grants: [{ ...grant, bot: { ...grant.bot, lifecycleState: 'deleted' } }],
          },
          candidates: [],
          commands: { invite: 'new-command', remove: { [grant.id]: 'remove-command' } },
        },
        form: null,
        params: { workspaceId: workspace.id, groupId: group.id },
      },
    }).body;
    expect(html).toContain('Deleted Bot · Historical identity retained');
    expect(html).toContain('Membership retained');
    expect(html).not.toContain('View allowed context');
    expect(html).toContain('Invited by Ada');
  });
});

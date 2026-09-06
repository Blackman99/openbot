import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Permissions from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/permissions/+page.svelte';
import BotPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/+page.svelte';
import { bot, user, workspace } from '../fixtures/bots.js';
const second = {
  id: 'fe661304-a1bc-4767-9a87-c47de763f749',
  email: 'bob@example.com',
  displayName: 'Bob',
};
describe('Bot permissions rendering', () => {
  it('offers explicit grants, discovery choices and per-person role/revoke forms with inactive access explained', () => {
    const html = render(Permissions, {
      props: {
        data: {
          user,
          workspace,
          workspaces: [workspace],
          bot: { id: bot.id, name: bot.name, visibility: 'private' },
          candidates: [second],
          members: [
            { user, role: 'owner', joinedAt: '2026-09-05T00:00:00.000Z', hasWorkspaceAccess: true },
            {
              user: second,
              role: 'editor',
              joinedAt: '2026-09-05T00:00:00.000Z',
              hasWorkspaceAccess: false,
            },
          ],
        },
        form: null,
        params: { workspaceId: workspace.id, botId: bot.id },
      },
    }).body;
    expect(html).toContain('Permissions for Researcher');
    expect(html).toContain('Grant access');
    expect(html).toContain('Workspace discoverable');
    expect(html).toContain('Revoke access');
    expect(html).toContain('No current workspace access');
    expect(html).not.toContain('System instructions');
    expect(html).not.toContain('Delete Bot');
  });
  it.each(['owner', 'editor', 'user', null] as const)(
    'links to permissions only for Bot role %s',
    (accessRole) => {
      const html = render(BotPage, {
        props: {
          data: {
            user,
            workspace: { ...workspace, role: 'owner' },
            workspaces: [workspace],
            bot: { ...bot, accessRole },
          },
          form: null,
          params: { workspaceId: workspace.id, botId: bot.id },
        },
      }).body;
      expect(html.includes(`/bots/${bot.id}/permissions`)).toBe(accessRole === 'owner');
    },
  );
});

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BotsPage from '../../src/routes/app/workspaces/[workspaceId]/bots/+page.svelte';
import BotPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/+page.svelte';
import AppPage from '../../src/routes/app/+page.svelte';
import { bot, input, summary, user, workspace } from '../fixtures/bots.js';
const base = { user, workspace, workspaces: [workspace] };
const model = {
  ...input.modelBinding,
  name: 'Team Basic',
  enabled: true,
  basic: true,
  collaboration: false,
  available: true,
};
describe('Bot identity pages', () => {
  it('offers private creation, field bounds, all default limits and explicit model capability choices', () => {
    const html = render(BotsPage, {
      props: {
        data: {
          ...base,
          bots: [summary],
          models: [
            model,
            { ...model, connectionId: user.id, enabled: false, name: 'Disabled model' },
          ],
          modelsUnavailable: false,
        },
        form: null,
        params: { workspaceId: workspace.id },
      },
    }).body;
    expect(html).toContain('Create Bot');
    expect(html).toContain('Private · Only you');
    expect(html).toContain('System instructions');
    expect(html).toContain('maxlength="32000"');
    for (const value of ['32768', '300', '8', '2']) expect(html).toContain(`value="${value}"`);
    expect(html).toContain('Chat-only — unsuitable for reliable delegation');
    expect(html).toContain('Disabled model');
    expect(html).toContain(`/app/workspaces/${workspace.id}/models`);
    expect(render(AppPage, { props: { data: base } }).body).toContain(
      `/app/workspaces/${workspace.id}/bots`,
    );
  });
  it('renders version identity, preserved instructions and persisted limits without future action controls', () => {
    const html = render(BotPage, {
      props: {
        form: null,
        data: { ...base, bot },
        params: { workspaceId: workspace.id, botId: bot.id },
      },
    }).body;
    expect(html).toContain('Version 1');
    expect(html).toContain('Created');
    expect(html).toContain('Cite sources.');
    expect(html).toContain('32768');
    expect(html).toContain('Chat-only — unsuitable for reliable delegation');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Run task');
  });
  it('shows only metadata for discovery and replaces stale capability claims when unavailable', () => {
    const discovered = {
      ...summary,
      accessRole: null,
      visibility: 'workspace' as const,
      bindingStatus: { state: 'unavailable' as const, reason: 'not-accessible' as const },
    };
    const html = render(BotPage, {
      props: {
        form: null,
        data: { ...base, workspace: { ...workspace, role: 'owner' }, bot: discovered },
        params: { workspaceId: workspace.id, botId: bot.id },
      },
    }).body;
    expect(html).toContain('Only Bot metadata is available');
    expect(html).toContain('Model unavailable');
    expect(html).not.toContain('System instructions');
    expect(html).not.toContain('Version 1');
    expect(html).not.toContain(input.modelBinding.connectionId);
    expect(html).not.toContain('Chat-only');
    expect(html).not.toContain('Collaboration-capable');
    const promoted = render(BotPage, {
      props: {
        form: null,
        data: { ...base, bot: { ...bot, bindingStatus: { state: 'ready', chatOnly: false } } },
        params: { workspaceId: workspace.id, botId: bot.id },
      },
    }).body;
    expect(promoted).toContain('Collaboration-capable');
    expect(promoted).not.toContain('Chat-only');
  });
});

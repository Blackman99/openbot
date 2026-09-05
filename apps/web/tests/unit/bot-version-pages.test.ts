import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import EditPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/edit/+page.svelte';
import HistoryPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/versions/+page.svelte';
import VersionPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/versions/[versionId]/+page.svelte';
import ComparisonPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/versions/compare/+page.svelte';
import DetailPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/+page.svelte';
import { bot, user, workspace } from '../fixtures/bots.js';
const base = { bot, user, workspace, workspaces: [workspace], canEdit: true };
const params = { workspaceId: workspace.id, botId: bot.id, versionId: bot.currentVersion.id };
const { configuration: _configuration, ...metadata } = bot.currentVersion;
describe('Bot version pages', () => {
  it('keeps an unavailable previously selected model visible and blocks accidental implicit rebinding', () => {
    const choice = JSON.stringify(bot.currentVersion.configuration.modelBinding);
    const html = render(EditPage, {
      props: {
        data: { ...base, models: [], modelsUnavailable: true },
        form: { values: { modelChoice: choice }, error: 'Model unavailable', blocked: false },
        params,
      },
    }).body;
    expect(html).toContain('Previously selected model unavailable');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save configuration<\/button>/u);
  });
  it('defaults to Keep current model while allowing unrelated edits without available models', () => {
    const html = render(EditPage, {
      props: { data: { ...base, models: [], modelsUnavailable: true }, form: null, params },
    }).body;
    expect(html).toContain('Keep current model');
    expect(html).toContain('name="modelChoice"');
    expect(html).toContain('System instructions');
    expect(html).toContain('name="expectedCurrentVersionId"');
    expect(html).toMatch(/<button[^>]*>Save configuration<\/button>/u);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Save configuration/u);
    expect(html).not.toContain('name="avatarObjectId"');
  });
  it('retains the submitted draft and old version on conflict even after a newer load', () => {
    const html = render(EditPage, {
      props: {
        data: {
          ...base,
          bot: { ...bot, currentVersion: { ...bot.currentVersion, id: workspace.id, number: 2 } },
          models: [],
          modelsUnavailable: false,
        },
        form: {
          values: {
            expectedCurrentVersionId: bot.currentVersion.id,
            instructions: 'My retained draft',
            modelChoice: 'keep',
          },
          error: 'Reload the current version',
          blocked: true,
        },
        params,
      },
    }).body;
    expect(html).toContain('My retained draft');
    expect(html).toContain(`name="expectedCurrentVersionId" value="${bot.currentVersion.id}"`);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save configuration<\/button>/u);
    expect(html).toContain('Reload current version');
  });
  it('lists author time and rationale with explicit comparison and older-page navigation', () => {
    const html = render(HistoryPage, {
      props: {
        data: {
          ...base,
          history: {
            currentVersionId: bot.currentVersion.id,
            versions: [{ ...metadata, number: 2 }],
            nextBefore: 2,
          },
          limit: 1,
          before: null,
        },
        form: null,
        params,
      },
    }).body;
    for (const expected of [
      'Ada',
      metadata.createdAt,
      'Created',
      'Compare versions',
      'Older versions',
      'before=2',
    ])
      expect(html).toContain(expected);
  });
  it('restores only through historical source IDs and approved private avatar previews', () => {
    const avatarId = 'a781b698-0122-4b2d-92bf-0036b947b188';
    const version = {
      ...bot.currentVersion,
      configuration: { ...bot.currentVersion.configuration, avatarObjectId: avatarId },
    };
    const html = render(VersionPage, {
      props: { data: { ...base, version }, form: null, params },
    }).body;
    expect(html).toContain(`avatar?versionId=${version.id}`);
    expect(html).not.toContain(avatarId);
    expect(html).toContain('name="sourceVersionId"');
    expect(html).toContain('Restore as new version');
    const readonly = render(VersionPage, {
      props: { data: { ...base, canEdit: false, version }, form: null, params },
    }).body;
    expect(readonly).not.toContain('Restore as new version');
  });
  it('shows safe field labels and escaped differences, with images for avatar changes', () => {
    const data = {
      ...base,
      fromVersion: { id: bot.currentVersion.id, number: 1 },
      toVersion: { id: workspace.id, number: 2 },
      comparison: {
        fromVersionId: bot.currentVersion.id,
        toVersionId: workspace.id,
        differences: [
          {
            field: 'instructions' as const,
            before: '<script>old()</script>',
            after: 'Changed instructions',
          },
          { field: 'avatarObjectId' as const, before: null, after: bot.id },
          { field: 'limits.maxTurns' as const, before: 8, after: 2 },
        ],
      },
    };
    const html = render(ComparisonPage, { props: { data, form: null, params } }).body;
    for (const expected of [
      'System instructions',
      'Avatar',
      'Turn limit',
      '&lt;script>old()',
      `avatar?versionId=${workspace.id}`,
    ])
      expect(html).toContain(expected);
    expect(html).not.toContain('<script>old()');
    expect(html).not.toContain('name="avatarObjectId"');
  });
  it('exposes history to Bot users and editing only to owners or editors', () => {
    const owner = render(DetailPage, { props: { data: base, form: null, params } }).body;
    expect(owner).toContain('Version history');
    expect(owner).toContain('Edit configuration');
    const reader = render(DetailPage, {
      props: { data: { ...base, bot: { ...bot, accessRole: 'user' } }, form: null, params },
    }).body;
    expect(reader).toContain('Version history');
    expect(reader).not.toContain('Edit configuration');
  });
});

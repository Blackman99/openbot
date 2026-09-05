import CopyPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/copy/+page.svelte';
import { preview } from '../fixtures/bot-copy.js';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import DetailPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/+page.svelte';
import { bot, user, workspace } from '../fixtures/bots.js';
it('offers configuration copying to direct Bot users', () => {
  const html = render(DetailPage, {
    props: {
      data: { bot: { ...bot, accessRole: 'user' }, user, workspace, workspaces: [workspace] },
      form: null,
      params: { workspaceId: workspace.id, botId: bot.id },
    },
  }).body;
  expect(html).toContain('Copy configuration');
});

it('shows explicit included and excluded fields, safe avatar route and preserved review content', () => {
  const value = {
    ...preview,
    configuration: {
      ...preview.configuration,
      avatarObjectId: user.id,
      instructions: '<script>doNotRun()</script>\n  Keep spaces.',
    },
  };
  const html = render(CopyPage, {
    props: {
      data: {
        bot,
        user,
        workspace,
        workspaces: [workspace],
        preview: value,
        models: [],
        modelsUnavailable: false,
      },
      form: null,
      params: { workspaceId: workspace.id, botId: bot.id },
    },
  }).body;
  for (const text of [
    'Included',
    'Excluded',
    'Provider credentials and sensitive headers',
    'Permissions and ACLs',
    'Conversation and task history',
    'Memory',
    'File contents',
    'Prior audits',
    'Cancel',
    'only owner',
    `avatar?versionId=${preview.sourceVersionId}`,
    '&lt;script>doNotRun()',
    'Keep source model',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('<script>doNotRun()');
  expect(html).not.toContain('name="avatarObjectId"');
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Confirm private copy/u);
});
it('requires accessible replacement and keeps stale or unconfirmed submissions blocked', () => {
  const data = {
    bot,
    user,
    workspace,
    workspaces: [workspace],
    preview: {
      ...preview,
      bindingStatus: { state: 'unavailable' as const, reason: 'not-accessible' as const },
    },
    models: [],
    modelsUnavailable: false,
  };
  const params = { workspaceId: workspace.id, botId: bot.id };
  const html = render(CopyPage, { props: { data, form: null, params } }).body;
  expect(html).toContain('replacement is required');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm private copy/u);
  const stale = render(CopyPage, {
    props: {
      data: { ...data, preview: { ...preview, sourceVersionId: workspace.id } },
      form: {
        values: { expectedCurrentVersionId: preview.sourceVersionId, modelChoice: 'keep' },
        error: 'Reload preview',
        blocked: true,
      },
      params,
    },
  }).body;
  expect(stale).toContain(`name="expectedCurrentVersionId" value="${preview.sourceVersionId}"`);
  expect(stale).toMatch(/<button[^>]*disabled[^>]*>Confirm private copy/u);
  expect(stale).toContain('Check your Bots');
});

it('hides the copy action on deleted Bot identities while preserving protected version history', () => {
  const html = render(DetailPage, {
    props: {
      data: {
        bot: { ...bot, lifecycleState: 'deleted' },
        user,
        workspace,
        workspaces: [workspace],
      },
      form: null,
      params: { workspaceId: workspace.id, botId: bot.id },
    },
  }).body;
  expect(html).not.toContain('Copy configuration');
  expect(html).toContain('Version history');
});

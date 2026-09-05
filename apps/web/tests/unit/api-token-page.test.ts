import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import Page from '../../src/routes/app/workspaces/[workspaceId]/settings/api-tokens/+page.svelte';
import AppPage from '../../src/routes/app/+page.svelte';
const user = { id: 'user-id', email: 'ada@example.com', displayName: 'Ada' };
const workspace = { id: 'workspace-id', name: 'Team', description: '', role: 'member' as const };
const token = {
  id: 'token-id',
  creatorUserId: user.id,
  workspaceId: workspace.id,
  name: '<script>unsafe()</script>',
  scopes: ['me:read'],
  createdAt: '2030-01-01T00:00:00.000Z',
  expiresAt: '2030-02-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};
const data = {
  user,
  workspace,
  workspaces: [workspace],
  tokens: [token],
  availableScopes: ['me:read', 'bots:read'],
};
it('shows the token settings, selected scopes, lifecycle metadata and creation-only copy control', () => {
  const html = render(Page, {
    props: { params: { workspaceId: workspace.id }, data, form: null },
  }).body;
  expect(html).toContain('API tokens');
  expect(html).toContain('name="scope"');
  expect(html).toContain('value="me:read"');
  expect(html).toContain('Never used');
  expect(html).toContain('Revoke');
  expect(html).not.toContain('<script>unsafe()');
  expect(html).not.toContain('Copy token');
  const secret = 'ob_' + 'b'.repeat(43);
  const created = render(Page, {
    props: {
      params: { workspaceId: workspace.id },
      data,
      form: {
        action: 'create',
        secret,
        message: 'Copy this token now. It will not be shown again.',
      },
    },
  }).body;
  expect(created).toContain('Copy token');
  expect(created).toContain(secret);
  expect(render(AppPage, { props: { data } }).body).toContain(
    '/app/workspaces/workspace-id/settings/api-tokens',
  );
});

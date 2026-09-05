import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import AppPage from '../../src/routes/app/+page.svelte';
import ModelsPage from '../../src/routes/app/workspaces/[workspaceId]/models/+page.svelte';
import type { SharedConnectionView } from '../../src/lib/server/workspace-provider-api.js';

const user = { id: 'member', displayName: 'Member', email: 'member@example.com' };
const workspace = { id: 'workspace-1', name: 'Team', description: '', role: 'member' as const };

it('links every workspace member to shared model settings', () => {
  expect(
    render(AppPage, { props: { data: { user, workspace, workspaces: [workspace] } } }).body,
  ).toContain('href="/app/workspaces/workspace-1/models"');
});

const connection: SharedConnectionView = {
  id: 'shared-1',
  name: 'Shared model',
  protocol: 'anthropic-messages',
  modelId: 'model',
  availability: 'available',
  lastProbe: {
    testedAt: '2030-01-02T00:00:00.000Z',
    text: { ok: true, code: 'passed' },
    action: { ok: false, code: 'provider_action_unsupported' },
  },
  settings: {
    id: 'shared-1',
    name: 'Shared model',
    protocol: 'anthropic-messages',
    anthropicVersion: '2023-01-01',
    modelId: 'model',
    baseUrl: 'https://models.example/v1',
    enabled: true,
    apiKeyConfigured: true,
    headerNames: ['x-secret'],
    lastProbe: {
      testedAt: '2030-01-02T00:00:00.000Z',
      text: { ok: true, code: 'passed', raw: 'admin-evidence' },
      action: { ok: false, code: 'provider_action_unsupported', raw: '{}' },
    },
  },
};
it('shows members model health and usage controls without connection management or configuration', () => {
  const html = render(ModelsPage, {
    props: { data: { workspace, canManage: false, connections: [connection] }, form: null },
  }).body;
  for (const text of [
    'Workspace models',
    'href="/app/workspaces/workspace-1/models/shared-1/capabilities"',
    'Shared model',
    'Anthropic Messages',
    'Text stream: passed',
    'Structured actions: unavailable',
    '2030-01-02',
    'action="?/test"',
  ])
    expect(html).toContain(text);
  for (const text of [
    'action="?/save"',
    'action="?/disable"',
    'name="apiKey"',
    'name="headers"',
    'models.example',
    'x-secret',
    'admin-evidence',
  ])
    expect(html).not.toContain(text);
});

it('uses fresh management authority to show masked all-protocol settings, edit and disable controls', () => {
  const html = render(ModelsPage, {
    props: {
      data: { workspace, canManage: true, connections: [connection] },
      form: { success: 'Workspace connection saved.' },
    },
  }).body;
  for (const text of [
    'Add a shared model',
    'Test and save',
    'Edit connection',
    'API key: configured',
    'x-secret',
    'admin-evidence',
    'action="?/disable"',
    'type="password"',
    'name="headers"',
    'OpenAI Chat Completions',
    'OpenAI Responses',
    'Anthropic Messages',
    'value="2023-01-01"',
    'role="status"',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('action="?/delete"');
  expect(html).not.toContain('value="configured"');
});

it('retains disabled model identity with unavailable state and escapes names and feedback', () => {
  const html = render(ModelsPage, {
    props: {
      data: {
        workspace,
        canManage: false,
        connections: [
          { ...connection, name: '<script>secret()</script>', availability: 'unavailable' },
        ],
      },
      form: { error: '<img src=x onerror=secret()>' },
    },
  }).body;
  expect(html).toContain('Unavailable (disabled)');
  expect(html).toContain('value="shared-1"');
  expect(html).toMatch(/<button[^>]*disabled/u);
  expect(html).toContain('role="alert"');
  expect(html).not.toContain('<script>secret()');
  expect(html).not.toContain('<img src=x');
});

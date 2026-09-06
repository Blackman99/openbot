import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import CapabilityEditor from '../../src/lib/components/CapabilityEditor.svelte';
import { catalog, preview, observedAt } from '../fixtures/capability.js';
const data = {
  catalog,
  preview,
  choices: [{ id: 'model-2', name: 'Team model', enabled: true }],
  backHref: '/app/settings/models',
};
it('shows Basic, Collaboration and unknown Enhanced evidence with deterministic exclusions to readonly members', () => {
  const html = render(CapabilityEditor, {
    props: { data: { ...data, workspaceId: 'team', catalog: { ...catalog, canManage: false } } },
  }).body;
  for (const text of [
    'Basic · chat-only',
    'Collaboration: unavailable',
    'Enhanced',
    'Vision input: unknown',
    'owner-1',
    observedAt,
    'provider_action_unsupported',
    'Team model',
    'Capability unknown',
    'Not accessible',
    'Selected model',
    'same workspace',
    'No provider request',
  ])
    expect(html).toContain(text);
  for (const text of [
    'action="?/override"',
    'action="?/reprobe"',
    'action="?/fallbacks"',
    'name="rationale"',
    'name="apiKey"',
  ])
    expect(html).not.toContain(text);
});
it('shows authorized revisioned edits and persistent stale manual evidence', () => {
  const html = render(CapabilityEditor, {
    props: {
      data: {
        ...data,
        catalog: {
          ...catalog,
          generation: 1,
          flags: {
            ...catalog.flags,
            visionInput: {
              ...catalog.flags.visionInput,
              manualBadge: true,
              override: {
                value: true,
                rationale: 'Verified earlier target',
                actorUserId: 'admin-2',
                createdAt: observedAt,
                generation: 0,
                active: false,
              },
            },
          },
        },
      },
    },
  }).body;
  for (const text of [
    'action="?/override"',
    'action="?/reprobe"',
    'action="?/fallbacks"',
    'name="expectedRevision" value="4"',
    'name="rationale"',
    'required="" maxlength="500"',
    'Manual override',
    'Stale',
    'target changed',
    'admin-2',
    'Verified earlier target',
    'does not grant support',
    'Move up',
    'Remove fallback',
    'Add fallback',
  ])
    expect(html).toContain(text);
});
it('requires a reload after conflicts and keeps disabled re-probes unavailable', () => {
  const html = render(CapabilityEditor, {
    props: {
      data: { ...data, catalog: { ...catalog, enabled: false } },
      form: { error: '<script>secret()</script>', reloadRequired: true },
    },
  }).body;
  expect(html).toContain('Reload capabilities');
  expect(html).toMatch(/<fieldset[^>]*disabled/u);
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Re-probe capabilities/u);
  expect(html).not.toContain('<script>secret()');
});

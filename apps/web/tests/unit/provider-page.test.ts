import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import ProviderPage from '../../src/routes/app/settings/models/+page.svelte';

it('renders personal connection management, masked credentials, and dated probe evidence', () => {
  const rendered = render(ProviderPage, {
    props: {
      data: {
        connections: [
          {
            id: 'model-id',
            name: 'Private model',
            baseUrl: 'https://models.example/v1',
            modelId: 'chat-model',
            enabled: true,
            apiKeyConfigured: true,
            headerNames: ['x-secret'],
            lastProbe: {
              testedAt: '2030-01-02T00:00:00.000Z',
              text: { ok: true, code: 'passed', raw: 'safe response' },
              action: { ok: false, code: 'provider_action_unsupported', raw: '{}' },
            },
          },
        ],
      },
      form: null,
    },
  });
  for (const text of [
    'Personal models',
    'Test and save',
    'Private model',
    'API key: configured',
    'x-secret',
    'Text stream: passed',
    'Structured actions: unavailable',
    '2030-01-02',
    'Disable',
    'Delete',
    'Test again',
    'type="password"',
    'name="headers"',
  ])
    expect(rendered.body).toContain(text);
  expect(rendered.body).not.toContain('value="configured"');
});

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
            protocol: 'anthropic-messages',
            anthropicVersion: '2023-01-01',
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
    'name="protocol"',
    'OpenAI Responses',
    'Anthropic Messages',
    'name="anthropicVersion"',
    'value="2023-01-01"',
    'pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"',
  ])
    expect(rendered.body).toContain(text);
  expect(rendered.body).not.toContain('value="configured"');
});

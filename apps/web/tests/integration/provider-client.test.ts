import { expect, it, vi } from 'vitest';
import { ProviderApiClient } from '../../src/lib/server/provider-api.js';

const connection = {
  id: 'connection-id',
  name: 'My model',
  baseUrl: 'https://models.example/v1',
  modelId: 'chat-model',
  enabled: true,
  apiKeyConfigured: true,
  headerNames: ['x-secret'],
  lastProbe: {
    testedAt: '2030-01-02T00:00:00.000Z',
    text: { ok: true, code: 'passed', raw: 'OK' },
    action: { ok: false, code: 'provider_action_unsupported', raw: '{}' },
  },
};

it('sends authenticated provider requests and accepts only safe metadata fields', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([connection]))
    .mockResolvedValueOnce(Response.json(connection, { status: 201 }))
    .mockResolvedValueOnce(Response.json([{ ...connection, apiKey: 'leaked-secret' }]));
  const client = new ProviderApiClient(
    request,
    'http://api.internal:3001',
    'https://openbot.example/',
  );
  expect(await client.list('token')).toEqual({ ok: true, value: [connection] });
  expect(
    await client.save('token', {
      name: 'Model',
      baseUrl: connection.baseUrl,
      modelId: 'chat',
      apiKey: 'secret',
      headers: {},
    }),
  ).toEqual({ ok: true, value: connection });
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST',
    headers: {
      cookie: 'openbot_session=token',
      origin: 'https://openbot.example',
      'content-type': 'application/json',
    },
  });
  expect(await client.list('token')).toEqual({ ok: false, code: 'provider_unavailable' });
});

it('drops upstream error text and unknown codes instead of leaking secret values', async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json(
      { error: { code: 'upstream said secret', message: 'Bearer key' } },
      { status: 500 },
    ),
  );
  expect(
    await new ProviderApiClient(request, 'http://api', 'http://localhost:3000').list('token'),
  ).toEqual({ ok: false, code: 'provider_unavailable' });
});

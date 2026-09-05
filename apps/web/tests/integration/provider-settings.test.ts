import { expect, it, vi } from 'vitest';
import { actions, load } from '../../src/routes/app/settings/models/+page.server.js';
const identity = {
  user: { id: 'user-id', displayName: 'Ada', email: 'ada@example.com' },
  workspace: { id: 'workspace-id', name: 'My Workspace' },
};
const cookies = { get: () => 'session-token' };

it('loads personal settings only after authentication', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(Response.json([]));
  expect(await load({ cookies, fetch: request, setHeaders: vi.fn() } as never)).toEqual({
    connections: [],
  });
  await expect(
    load({ cookies: { get: () => undefined }, fetch: request, setHeaders: vi.fn() } as never),
  ).rejects.toMatchObject({ location: '/sign-in', status: 303 });
});

it('forwards a test-and-save action and never echoes failed API keys or header input', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'provider_url_not_allowed' } }, { status: 400 }),
    );
  const response = await actions.save({
    cookies,
    fetch: request,
    setHeaders: vi.fn(),
    request: new Request('http://localhost:3000/app/settings/models?/save', {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Model',
        baseUrl: 'https://models.example/v1',
        modelId: 'model',
        apiKey: 'api-secret-value',
        headers: '{"x-secret":"header-secret-value"}',
      }),
    }),
  } as never);
  expect(response).toMatchObject({
    status: 400,
    data: { error: 'This endpoint is outside the instance network policy.' },
  });
  expect(JSON.stringify(response)).not.toMatch(/api-secret-value|header-secret-value/u);
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
    apiKey: 'api-secret-value',
    headers: { 'x-secret': 'header-secret-value' },
  });
});

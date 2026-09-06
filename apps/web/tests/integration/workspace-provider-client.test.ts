import { expect, it, vi } from 'vitest';
import { WorkspaceProviderApiClient } from '../../src/lib/server/workspace-provider-api.js';

const token = 'a'.repeat(43);
const report = {
  testedAt: '2030-01-02T00:00:00.000Z',
  text: { ok: true, code: 'passed' },
  action: { ok: false, code: 'provider_action_unsupported' },
};
const connection = {
  id: 'connection-1',
  protocol: 'openai-responses',
  name: 'Shared model',
  modelId: 'model',
  availability: 'available',
  lastProbe: report,
};

it('loads a scoped minimal member view with the current session', async () => {
  const value = { canManage: false, connections: [connection] };
  const request = vi.fn<typeof fetch>(async () => Response.json(value));
  const client = new WorkspaceProviderApiClient(request, 'http://api:3001', 'https://web.example');
  expect(await client.list(token, 'workspace-1')).toEqual({ ok: true, value });
  expect(request.mock.calls[0]?.[0]).toBe(
    'http://api:3001/api/v1/workspaces/workspace-1/model-connections',
  );
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    method: 'GET',
    headers: { cookie: `openbot_session=${token}`, origin: 'https://web.example' },
  });
  expect(new Headers(request.mock.calls[0]?.[1]?.headers).has('content-type')).toBe(false);
});

const settings = {
  id: connection.id,
  protocol: connection.protocol,
  name: connection.name,
  modelId: connection.modelId,
  baseUrl: 'https://models.example/v1',
  enabled: true,
  apiKeyConfigured: true,
  headerNames: ['x-secret'],
  lastProbe: {
    ...report,
    text: { ...report.text, raw: 'OK' },
    action: { ...report.action, raw: '{}' },
  },
};

it.each(['openai-chat', 'openai-responses', 'anthropic-messages'])(
  'loads administrator settings for %s without any credential values',
  async (protocol) => {
    const configured = {
      ...connection,
      protocol,
      settings: {
        ...settings,
        protocol,
        ...(protocol === 'anthropic-messages' ? { anthropicVersion: '2023-06-01' } : {}),
      },
    };
    const value = { canManage: true, connections: [configured] };
    const client = new WorkspaceProviderApiClient(
      async () => Response.json(value),
      'http://api',
      'http://web',
    );
    expect(await client.list(token, 'workspace-1')).toEqual({ ok: true, value });
  },
);

it('creates, updates and disables only the scoped connection, and sends member probes without a body', async () => {
  const value = { canManage: true, connection: { ...connection, settings } };
  const request = vi.fn<typeof fetch>(async (url) =>
    Response.json(String(url).endsWith('/test') ? { report } : value),
  );
  const client = new WorkspaceProviderApiClient(request, 'http://api', 'http://web');
  const input = {
    protocol: 'openai-responses',
    name: 'Shared model',
    baseUrl: settings.baseUrl,
    modelId: 'model',
    apiKey: 'secret',
    headers: {},
  };
  expect(await client.save(token, 'workspace-1', input)).toEqual({ ok: true, value });
  expect(await client.update(token, 'workspace-1', connection.id, input)).toEqual({
    ok: true,
    value,
  });
  expect(await client.get(token, 'workspace-1', connection.id)).toEqual({ ok: true, value });
  expect(await client.disable(token, 'workspace-1', connection.id)).toEqual({ ok: true, value });
  expect(await client.test(token, 'workspace-1', connection.id)).toEqual({
    ok: true,
    value: { report },
  });
  expect(request.mock.calls.map(([url, init]) => [String(url), init?.method, init?.body])).toEqual([
    ['http://api/api/v1/workspaces/workspace-1/model-connections', 'POST', JSON.stringify(input)],
    [
      'http://api/api/v1/workspaces/workspace-1/model-connections/connection-1',
      'PUT',
      JSON.stringify(input),
    ],
    ['http://api/api/v1/workspaces/workspace-1/model-connections/connection-1', 'GET', undefined],
    [
      'http://api/api/v1/workspaces/workspace-1/model-connections/connection-1',
      'PATCH',
      '{"enabled":false}',
    ],
    [
      'http://api/api/v1/workspaces/workspace-1/model-connections/connection-1/test',
      'POST',
      undefined,
    ],
  ]);
  expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('content-type')).toBe(
    'application/json',
  );
  expect(new Headers(request.mock.calls[4]?.[1]?.headers).has('content-type')).toBe(false);
});

it.each([
  [401, 'authentication_required'],
  [403, 'workspace_forbidden'],
  [403, 'invalid_origin'],
  [404, 'connection_not_found'],
  [409, 'connection_disabled'],
  [409, 'connection_conflict'],
  [400, 'invalid_connection'],
  [400, 'provider_url_not_allowed'],
  [503, 'providers_not_configured'],
  [503, 'provider_operation_failed'],
  [503, 'provider_credentials_unavailable'],
])('preserves safe HTTP %i %s errors without upstream text', async (status, code) => {
  const client = new WorkspaceProviderApiClient(
    async () =>
      Response.json({ error: { code, message: 'upstream-secret' } }, { status: Number(status) }),
    'http://api',
    'http://web',
  );
  expect(await client.list(token, 'workspace-1')).toEqual({ ok: false, code });
});

it.each([
  { canManage: false, connections: [{ ...connection, settings }] },
  { canManage: false, connections: [{ ...connection, sealedCredentials: 'ciphertext' }] },
  { canManage: false, connections: [{ ...connection, lastProbe: settings.lastProbe }] },
  {
    canManage: true,
    connections: [{ ...connection, settings: { ...settings, apiKey: 'secret' } }],
  },
  { canManage: true, connections: [{ ...connection, settings: { ...settings, id: 'another' } }] },
  { canManage: false, connections: [connection, connection] },
])('rejects secret-bearing or inconsistent workspace views', async (value) => {
  const client = new WorkspaceProviderApiClient(
    async () => Response.json(value),
    'http://api',
    'http://web',
  );
  expect(await client.list(token, 'workspace-1')).toEqual({
    ok: false,
    code: 'provider_unavailable',
  });
});

it('keeps the deadline active while reading a stalled JSON body', async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
        ),
    );
    const pending = new WorkspaceProviderApiClient(request, 'http://api', 'http://web').list(
      token,
      'workspace-1',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ ok: false, code: 'provider_unavailable' });
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('rejects malformed sessions, unknown upstream errors and cross-connection details', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: { code: 'private-secret' } }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ canManage: false, connection }));
  const client = new WorkspaceProviderApiClient(request, 'http://api', 'http://web');
  expect(await client.list('forged;token=secret', 'workspace-1')).toEqual({
    ok: false,
    code: 'authentication_required',
  });
  expect(request).not.toHaveBeenCalled();
  expect(await client.list(token, 'workspace-1')).toEqual({
    ok: false,
    code: 'provider_unavailable',
  });
  expect(await client.get(token, 'workspace-1', 'other')).toEqual({
    ok: false,
    code: 'provider_unavailable',
  });
});

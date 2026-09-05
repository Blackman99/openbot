import { expect, it, vi } from 'vitest';
import {
  loadWorkspaceModelsPage,
  saveWorkspaceModelAction,
  testWorkspaceModelAction,
  disableWorkspaceModelAction,
} from '../../src/lib/server/workspace-provider-page.js';

const token = 'a'.repeat(43);
const user = { id: 'member', displayName: 'Member', email: 'member@example.com' };
const workspace = { id: 'workspace-1', name: 'Team', description: '', role: 'owner' };
function cookies() {
  return {
    get: vi.fn(() => token),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}

it('loads current workspace authority even when identity has no default workspace', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).endsWith('/me')
      ? Response.json({ user, workspace: null })
      : String(url).endsWith('/workspaces')
        ? Response.json({ workspaces: [workspace] })
        : Response.json({ canManage: false, connections: [] }),
  );
  const setHeaders = vi.fn();
  expect(
    await loadWorkspaceModelsPage({ cookies: cookies(), fetch, setHeaders }, workspace.id),
  ).toEqual({
    user,
    workspace,
    workspaces: [workspace],
    canManage: false,
    connections: [],
  });
  expect(fetch.mock.calls.at(-1)?.[0]).toBe(
    'http://localhost:3001/api/v1/workspaces/workspace-1/model-connections',
  );
  expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
});

function form(values: Record<string, string>) {
  return new Request('http://localhost:3000/app/workspaces/workspace-1/models', {
    method: 'POST',
    body: new URLSearchParams(values),
  });
}
it('sends only the selected workspace update and preserves saved credentials on blank input', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ error: { code: 'workspace_forbidden' } }, { status: 403 }),
  );
  const jar = cookies();
  const result = await saveWorkspaceModelAction(
    {
      cookies: jar,
      fetch,
      setHeaders: vi.fn(),
      request: form({
        id: 'connection-1',
        workspaceId: 'forged',
        actorRole: 'owner',
        protocol: 'anthropic-messages',
        anthropicVersion: '2023-01-01',
        name: 'Shared model',
        baseUrl: 'https://models.example/v1',
        modelId: 'model',
        apiKey: '',
        headers: '',
      }),
    },
    workspace.id,
  );
  expect(result).toMatchObject({
    status: 403,
    data: { error: expect.stringContaining('permission') },
  });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    'http://localhost:3001/api/v1/workspaces/workspace-1/model-connections/connection-1',
  );
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    protocol: 'anthropic-messages',
    anthropicVersion: '2023-01-01',
    name: 'Shared model',
    baseUrl: 'https://models.example/v1',
    modelId: 'model',
  });
  expect(jar.delete).not.toHaveBeenCalled();
});

it('runs member probes without accepting credential overrides and preserves unavailable state errors', async () => {
  const report = {
    testedAt: '2030-01-02T00:00:00.000Z',
    text: { ok: true, code: 'passed' },
    action: { ok: true, code: 'passed' },
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ report }))
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'connection_disabled' } }, { status: 409 }),
    );
  const context = { cookies: cookies(), fetch, setHeaders: vi.fn() };
  expect(
    await testWorkspaceModelAction(
      {
        ...context,
        request: form({ id: 'connection-1', apiKey: 'forged-secret', workspaceId: 'forged' }),
      },
      workspace.id,
    ),
  ).toEqual({ success: 'Connection test completed.' });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    'http://localhost:3001/api/v1/workspaces/workspace-1/model-connections/connection-1/test',
  );
  expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
  expect(
    await disableWorkspaceModelAction(
      { ...context, request: form({ id: 'connection-1' }) },
      workspace.id,
    ),
  ).toMatchObject({ status: 409 });
  expect(fetch.mock.calls[1]?.[1]?.body).toBe('{"enabled":false}');
});

it('never returns supplied credentials on failed saves and distinguishes preserve from clear', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(
      { error: { code: 'provider_url_not_allowed', message: 'secret-key' } },
      { status: 400 },
    ),
  );
  const context = { cookies: cookies(), fetch, setHeaders: vi.fn() };
  const result = await saveWorkspaceModelAction(
    {
      ...context,
      request: form({
        name: 'Model',
        protocol: 'openai-responses',
        apiKey: 'secret-key',
        headers: '{"x-secret":"secret-header"}',
      }),
    },
    workspace.id,
  );
  expect(result).toMatchObject({ status: 400 });
  expect(JSON.stringify(result)).not.toMatch(/secret-key|secret-header/u);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    protocol: 'openai-responses',
    apiKey: 'secret-key',
    headers: { 'x-secret': 'secret-header' },
  });
  await saveWorkspaceModelAction(
    {
      ...context,
      request: form({
        id: 'connection-1',
        protocol: 'openai-chat',
        clearApiKey: 'on',
        headers: '{}',
      }),
    },
    workspace.id,
  );
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
    apiKey: '',
    headers: {},
  });
  expect(
    await saveWorkspaceModelAction(
      { ...context, request: form({ headers: 'private malformed header' }) },
      workspace.id,
    ),
  ).toMatchObject({ status: 400, data: { error: 'Custom headers must be a JSON object.' } });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('retains removed member sessions while denying stale page loads, and clears expired sessions', async () => {
  const jar = cookies();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).endsWith('/me')
      ? Response.json({ user, workspace: null })
      : String(url).endsWith('/workspaces')
        ? Response.json({ workspaces: [workspace] })
        : Response.json({ error: { code: 'workspace_forbidden' } }, { status: 403 }),
  );
  await expect(
    loadWorkspaceModelsPage({ cookies: jar, fetch, setHeaders: vi.fn() }, workspace.id),
  ).rejects.toMatchObject({ status: 403 });
  expect(jar.delete).not.toHaveBeenCalled();
  await expect(
    testWorkspaceModelAction(
      {
        cookies: jar,
        fetch: async () => new Response(null, { status: 401 }),
        setHeaders: vi.fn(),
        request: form({ id: 'connection-1' }),
      },
      workspace.id,
    ),
  ).rejects.toMatchObject({ status: 303, location: '/sign-in' });
  expect(jar.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
});

import { expect, it, vi } from 'vitest';
import { loadCapabilitiesPage, capabilityAction } from '../../src/lib/server/capability-page.js';
import { catalog, preview } from '../fixtures/capability.js';
const token = 'a'.repeat(43);
function cookies() {
  return {
    get: vi.fn(() => token),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
}
it('loads only same-scope choices with a safe catalog and requested resolution preview', async () => {
  const report = {
    testedAt: '2030-01-02T00:00:00Z',
    text: { ok: true, code: 'passed' },
    action: { ok: false, code: 'failed' },
  };
  const request = vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith('/policy')
        ? { ...catalog, canManage: false }
        : String(url).includes('resolution-preview')
          ? preview
          : {
              canManage: false,
              connections: [
                {
                  id: 'model-2',
                  name: 'Team model',
                  protocol: 'anthropic-messages',
                  modelId: 'other',
                  availability: 'available',
                  lastProbe: report,
                },
              ],
            },
    ),
  );
  const setHeaders = vi.fn();
  const result = await loadCapabilitiesPage(
    {
      cookies: cookies(),
      fetch: request,
      setHeaders,
      url: new URL('http://web/capabilities?capability=collaboration'),
    },
    'model-1',
    'team',
  );
  expect(result.catalog.canManage).toBe(false);
  expect(result.choices).toEqual([{ id: 'model-2', name: 'Team model', enabled: true }]);
  expect(result.preview).toEqual(preview);
  expect(result.backHref).toBe('/app/workspaces/team/models');
  expect(
    request.mock.calls.every(([url]) => String(url).includes('/workspaces/team/model-connections')),
  ).toBe(true);
  expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
});
function form(values: Record<string, string> | [string, string][]) {
  return new Request('http://web/capabilities', {
    method: 'POST',
    body: new URLSearchParams(values),
  });
}
it('submits a justified override for the route scope and requires reload after a revision conflict', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(
      { error: { code: 'connection_conflict', message: 'private-upstream-secret' } },
      { status: 409 },
    ),
  );
  const result = await capabilityAction(
    {
      cookies: cookies(),
      fetch,
      setHeaders: vi.fn(),
      request: form({
        expectedRevision: '4',
        capability: 'visionInput',
        value: 'true',
        rationale: '  Image input verified  ',
        workspaceId: 'forged',
        connectionId: 'forged',
        actorUserId: 'forged',
      }),
    },
    'model-1',
    'override',
    'team',
  );
  expect(result).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining('Reload'), reloadRequired: true },
  });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    'http://localhost:3001/api/v1/workspaces/team/model-connections/model-1/overrides',
  );
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    expectedRevision: 4,
    capability: 'visionInput',
    value: true,
    rationale: 'Image input verified',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('private-upstream-secret');
});
it('preserves fallback order and sends reprobes with only the current revision', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(catalog));
  const context = { cookies: cookies(), fetch, setHeaders: vi.fn() };
  expect(
    await capabilityAction(
      {
        ...context,
        request: form([
          ['expectedRevision', '4'],
          ['requiredCapability', 'collaboration'],
          ['connectionIds', 'model-3'],
          ['connectionIds', 'model-2'],
          ['apiKey', 'forged'],
        ]),
      },
      'model-1',
      'fallbacks',
    ),
  ).toEqual({ success: 'Fallback order saved.' });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    expectedRevision: 4,
    requiredCapability: 'collaboration',
    connectionIds: ['model-3', 'model-2'],
  });
  expect(
    await capabilityAction(
      {
        ...context,
        request: form({ expectedRevision: '4', apiKey: 'forged', rationale: 'ignored' }),
      },
      'model-1',
      'reprobe',
    ),
  ).toEqual({ success: 'Capabilities re-probed.' });
  expect(fetch.mock.calls[1]?.[1]?.body).toBe('{"expectedRevision":4}');
});
it.each([
  { expectedRevision: '', capability: 'visionInput', value: 'true', rationale: 'proof' },
  { expectedRevision: '4.5', capability: 'visionInput', value: 'true', rationale: 'proof' },
  { expectedRevision: '4', capability: 'visionInput', value: 'true', rationale: '   ' },
  { expectedRevision: '4', capability: 'visionInput', value: 'true', rationale: 'x'.repeat(501) },
  { expectedRevision: '4', capability: 'price', value: 'true', rationale: 'proof' },
  { expectedRevision: '4', capability: 'visionInput', value: 'maybe', rationale: 'proof' },
])('rejects invalid overrides before requesting the API', async (input) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  expect(
    await capabilityAction(
      { cookies: cookies(), fetch, setHeaders: vi.fn(), request: form(input) },
      'model-1',
      'override',
    ),
  ).toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps removed-member sessions while denying policy management, and clears expired sessions', async () => {
  const jar = cookies();
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ error: { code: 'workspace_forbidden' } }, { status: 403 }),
  );
  const context = { cookies: jar, fetch, setHeaders: vi.fn() };
  expect(
    await capabilityAction(
      { ...context, request: form({ expectedRevision: '4' }) },
      'model-1',
      'reprobe',
      'team',
    ),
  ).toMatchObject({ status: 403 });
  await expect(
    loadCapabilitiesPage({ ...context, url: new URL('http://web') }, 'model-1', 'team'),
  ).rejects.toMatchObject({ status: 403 });
  expect(jar.delete).not.toHaveBeenCalled();
  await expect(
    capabilityAction(
      {
        ...context,
        fetch: async () => new Response(null, { status: 401 }),
        request: form({ expectedRevision: '4' }),
      },
      'model-1',
      'reprobe',
    ),
  ).rejects.toMatchObject({ status: 303, location: '/sign-in' });
  expect(jar.delete).toHaveBeenCalledWith('openbot_session', { path: '/' });
});

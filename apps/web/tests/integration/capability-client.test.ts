import { expect, it, vi } from 'vitest';
import { CapabilityApiClient } from '../../src/lib/server/capability-api.js';
import { catalog } from '../fixtures/capability.js';
const token = 'a'.repeat(43);
it('loads a safe scoped catalog without claiming Collaboration for a Basic model', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json(catalog));
  const client = new CapabilityApiClient(request, 'http://api:3001', 'https://web.example');
  expect(await client.get(token, 'model-1', 'team')).toEqual({ ok: true, value: catalog });
  expect(request.mock.calls[0]?.[0]).toBe(
    'http://api:3001/api/v1/workspaces/team/model-connections/model-1/policy',
  );
  const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
  expect(headers.get('cookie')).toBe(`openbot_session=${token}`);
  expect(headers.get('origin')).toBe('https://web.example');
  expect(headers.has('content-type')).toBe(false);
});

it('writes explicit revisioned policies and previews deterministic exclusions in either scope', async () => {
  const { preview } = await import('../fixtures/capability.js');
  const request = vi.fn<typeof fetch>(async (url) =>
    Response.json(String(url).includes('resolution-preview') ? preview : catalog),
  );
  const client = new CapabilityApiClient(request, 'http://api', 'https://web.example');
  const override = {
    expectedRevision: 4,
    capability: 'visionInput',
    value: true,
    rationale: 'Verified image input',
  };
  const fallbacks = {
    expectedRevision: 4,
    requiredCapability: 'collaboration',
    connectionIds: ['model-2'],
  };
  expect(await client.override(token, 'model-1', override)).toEqual({ ok: true, value: catalog });
  expect(await client.fallbacks(token, 'model-1', fallbacks, 'team')).toEqual({
    ok: true,
    value: catalog,
  });
  expect(await client.reprobe(token, 'model-1', 4)).toEqual({ ok: true, value: catalog });
  expect(await client.preview(token, 'model-1', 'collaboration', 'team')).toEqual({
    ok: true,
    value: preview,
  });
  expect(request.mock.calls.map(([url, init]) => [String(url), init?.method, init?.body])).toEqual([
    ['http://api/api/v1/model-connections/model-1/overrides', 'POST', JSON.stringify(override)],
    [
      'http://api/api/v1/workspaces/team/model-connections/model-1/fallbacks',
      'PUT',
      JSON.stringify(fallbacks),
    ],
    ['http://api/api/v1/model-connections/model-1/reprobe', 'POST', '{"expectedRevision":4}'],
    [
      'http://api/api/v1/workspaces/team/model-connections/model-1/resolution-preview?capability=collaboration',
      'GET',
      undefined,
    ],
  ]);
  expect(new Headers(request.mock.calls[2]?.[1]?.headers).get('content-type')).toBe(
    'application/json',
  );
  expect(new Headers(request.mock.calls[3]?.[1]?.headers).has('content-type')).toBe(false);
});

it.each(['openai-chat', 'openai-responses', 'anthropic-messages'])(
  'accepts attributable evidence for %s while optional capabilities remain unknown',
  async (protocol) => {
    const value = { ...catalog, protocol };
    expect(
      await new CapabilityApiClient(
        async () => Response.json(value),
        'http://api',
        'http://web',
      ).get(token, 'model-1'),
    ).toEqual({ ok: true, value });
  },
);
it.each([
  { ...catalog, apiKey: 'secret' },
  { ...catalog, sealedCredentials: 'ciphertext' },
  { ...catalog, headerNames: ['x-secret'] },
  { ...catalog, collaboration: true },
  { ...catalog, enhanced: { visionInput: true } },
  { ...catalog, revision: 1.5 },
  { ...catalog, flags: { ...catalog.flags, text: { ...catalog.flags.text, raw: 'private' } } },
  {
    ...catalog,
    flags: { ...catalog.flags, text: { ...catalog.flags.text, observedAt: 'invalid' } },
  },
  { ...catalog, flags: { ...catalog.flags, text: { ...catalog.flags.text, manualBadge: true } } },
  { ...catalog, id: 'other-connection' },
  { ...catalog, fallbacks: { ...catalog.fallbacks, connectionIds: ['model-2', 'model-2'] } },
])('rejects secret-bearing or inconsistent capability catalogs', async (value) => {
  expect(
    await new CapabilityApiClient(async () => Response.json(value), 'http://api', 'http://web').get(
      token,
      'model-1',
    ),
  ).toEqual({ ok: false, code: 'provider_unavailable' });
});
it('preserves an inactive manual badge without granting a changed target capabilities', async () => {
  const value = {
    ...catalog,
    generation: 1,
    flags: {
      ...catalog.flags,
      visionInput: {
        ...catalog.flags.visionInput,
        manualBadge: true,
        override: {
          value: true,
          rationale: 'Earlier target verified',
          actorUserId: 'owner-1',
          createdAt: '2030-01-01T00:00:00Z',
          generation: 0,
          active: false,
        },
      },
    },
  };
  expect(
    await new CapabilityApiClient(async () => Response.json(value), 'http://api', 'http://web').get(
      token,
      'model-1',
    ),
  ).toEqual({ ok: true, value });
});
it('rejects preview metadata for inaccessible models and invalid selection order', async () => {
  const { preview } = await import('../fixtures/capability.js');
  for (const value of [
    { ...preview, selectedId: 'model-1' },
    { ...preview, order: ['model-1'] },
    { ...preview, requiredCapability: 'basic' },
    { ...preview, primaryId: 'other' },
    {
      ...preview,
      candidates: [
        ...preview.candidates,
        { id: 'foreign', eligible: false, reason: 'not_accessible', name: 'Private' },
      ],
    },
    {
      ...preview,
      candidates: [{ ...preview.candidates[0], apiKey: 'secret' }, ...preview.candidates.slice(1)],
    },
  ]) {
    expect(
      await new CapabilityApiClient(
        async () => Response.json(value),
        'http://api',
        'http://web',
      ).preview(token, 'model-1', 'collaboration'),
    ).toEqual({ ok: false, code: 'provider_unavailable' });
  }
});
it.each([
  [403, 'workspace_forbidden'],
  [403, 'invalid_origin'],
  [404, 'connection_not_found'],
  [409, 'connection_conflict'],
  [409, 'connection_disabled'],
  [400, 'invalid_capability_policy'],
  [400, 'duplicate_fallback'],
  [400, 'fallback_cycle'],
  [400, 'fallback_unavailable'],
  [400, 'fallback_capability_required'],
  [503, 'provider_operation_failed'],
])('preserves safe %i %s failures without retrying', async (status, code) => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ error: { code, message: 'secret' } }, { status: Number(status) }),
  );
  expect(
    await new CapabilityApiClient(request, 'http://api', 'http://web').reprobe(token, 'model-1', 4),
  ).toEqual({ ok: false, code });
  expect(request).toHaveBeenCalledTimes(1);
});
it('rejects forged sessions and unknown or status-mismatched errors', async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ error: { code: 'connection_conflict' } }, { status: 503 }),
  );
  const client = new CapabilityApiClient(request, 'http://api', 'http://web');
  expect(await client.get('bad;token', 'model-1')).toEqual({
    ok: false,
    code: 'authentication_required',
  });
  expect(request).not.toHaveBeenCalled();
  expect(await client.get(token, 'model-1')).toEqual({ ok: false, code: 'provider_unavailable' });
});
it('keeps its deadline through reading a stalled JSON response', async () => {
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
    const pending = new CapabilityApiClient(request, 'http://api', 'http://web').get(
      token,
      'model-1',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ ok: false, code: 'provider_unavailable' });
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it('rejects non-string capability enums and unauthored or inactive manual claims', async () => {
  for (const evidence of [
    { ...catalog.flags.text, status: ['supported'] },
    { ...catalog.flags.text, source: ['probe'] },
    { ...catalog.flags.text, actorUserId: null },
    { ...catalog.flags.text, source: 'manual' },
    {
      ...catalog.flags.text,
      manualBadge: true,
      source: 'manual',
      override: {
        value: true,
        rationale: 'passed',
        actorUserId: 'owner-1',
        createdAt: '2030-01-02T00:00:00.000Z',
        generation: 0,
        active: false,
      },
    },
  ]) {
    const value = { ...catalog, flags: { ...catalog.flags, text: evidence } };
    expect(
      await new CapabilityApiClient(
        async () => Response.json(value),
        'http://api',
        'http://web',
      ).get(token, 'model-1'),
    ).toEqual({ ok: false, code: 'provider_unavailable' });
  }
});
it('accepts canonical UUID identity for equivalent uppercase routes on every policy operation', async () => {
  const id = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const value = { ...catalog, id, fallbacks: { ...catalog.fallbacks, connectionIds: [] } };
  const resolved = {
    primaryId: id,
    requiredCapability: 'basic',
    selectedId: id,
    order: [id],
    candidates: [{ id, eligible: true, reason: null }],
  };
  const request = vi.fn<typeof fetch>(async (url) =>
    Response.json(String(url).includes('resolution-preview') ? resolved : value),
  );
  const client = new CapabilityApiClient(request, 'http://api', 'http://web');
  for (const result of [
    await client.get(token, id.toUpperCase()),
    await client.override(token, id.toUpperCase(), { expectedRevision: 4 }),
    await client.fallbacks(token, id.toUpperCase(), { expectedRevision: 4 }),
    await client.reprobe(token, id.toUpperCase(), 4),
  ])
    expect(result).toEqual({ ok: true, value });
  expect(await client.preview(token, id.toUpperCase(), 'basic')).toEqual({
    ok: true,
    value: resolved,
  });
});

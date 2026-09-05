import { expect, it, vi } from 'vitest';
import { BotCopyApiClient } from '../../src/lib/server/bot-copy-api.js';
import { bot, token, workspace } from '../fixtures/bots.js';
import { preview, copied } from '../fixtures/bot-copy.js';
function client(payload: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
  return {
    request,
    api: new BotCopyApiClient(request, 'http://localhost:3001/', 'http://localhost:3000'),
  };
}
it('validates preview content and a private version-one receipt and preserves the confirmation precondition', async () => {
  expect(await client({ preview }).api.preview(token, workspace.id, bot.id)).toEqual({
    status: 'available',
    value: preview,
  });
  const { request, api } = client({ bot: copied }, 201);
  expect(
    await api.confirm(token, workspace.id, bot.id, {
      expectedCurrentVersionId: preview.sourceVersionId,
    }),
  ).toEqual({ status: 'available', value: copied });
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    redirect: 'error',
    body: JSON.stringify({ expectedCurrentVersionId: preview.sourceVersionId }),
    headers: { origin: 'http://localhost:3000', cookie: `openbot_session=${token}` },
  });
});
it.each([
  { ...preview, credentials: 'provider-secret' },
  { ...preview, sourceBotId: workspace.id },
  { ...preview, included: [] },
  { ...preview, excluded: ['credentials'] },
  { ...preview, configuration: { ...preview.configuration, authorization: 'sensitive' } },
  {
    ...preview,
    configuration: {
      ...preview.configuration,
      modelBinding: { ...preview.configuration.modelBinding, apiKey: 'sensitive' },
    },
  },
  { ...preview, bindingStatus: { state: 'ready', chatOnly: true, apiKey: 'sensitive' } },
])('rejects unexpected preview fields or identities', async (value) => {
  expect(await client({ preview: value }).api.preview(token, workspace.id, bot.id)).toEqual({
    status: 'unavailable',
  });
});
it.each([
  { ...copied, id: bot.id },
  { ...copied, visibility: 'workspace' },
  { ...copied, accessRole: 'user' },
  { ...copied, currentVersion: { ...copied.currentVersion, id: preview.sourceVersionId } },
  { ...copied, currentVersion: { ...copied.currentVersion, number: 2 } },
  {
    ...copied,
    currentVersion: { ...copied.currentVersion, createdAt: '2026-02-30T00:00:00.000Z' },
  },
  { ...copied, currentVersion: { ...copied.currentVersion, rationale: 'Created' } },
  {
    ...copied,
    currentVersion: {
      ...copied.currentVersion,
      configuration: { ...preview.configuration, credentials: 'secret' },
    },
  },
])('treats inconsistent successful receipts as unconfirmed', async (value) => {
  expect(
    await client({ bot: value }, 201).api.confirm(token, workspace.id, bot.id, {
      expectedCurrentVersionId: preview.sourceVersionId,
    }),
  ).toEqual({ status: 'unavailable' });
});
it.each([
  [401, 'authentication_required', 'anonymous'],
  [403, 'bot_forbidden', 'forbidden'],
  [403, 'invalid_origin', 'forbidden'],
  [400, 'invalid_bot_copy_request', 'invalid'],
  [413, 'invalid_bot_copy_request', 'invalid'],
  [415, 'invalid_bot_copy_request', 'invalid'],
  [409, 'bot_version_conflict', 'conflict'],
  [409, 'bot_avatar_unavailable', 'avatar-unavailable'],
  [503, 'bot_copy_unavailable', 'unavailable'],
  [500, 'authentication_required', 'unavailable'],
] as const)(
  'maps only matching HTTP status and fixed error code %s %s',
  async (status, code, expected) => {
    expect(
      await client({ error: { code } }, status).api.confirm(token, workspace.id, bot.id, {
        expectedCurrentVersionId: preview.sourceVersionId,
      }),
    ).toEqual({ status: expected });
  },
);
it('rejects forged request fields before transport and bounds success and error response bodies', async () => {
  const { api, request } = client({ bot: copied }, 201);
  const extras: Array<Record<string, unknown>> = [
    { avatarObjectId: bot.id },
    { modelBinding: null },
    { modelBinding: { apiKey: 'secret' } },
    { visibility: 'workspace' },
  ];
  for (const extra of extras)
    expect(
      await api.confirm(
        token,
        workspace.id,
        bot.id,
        Object.assign({ expectedCurrentVersionId: preview.sourceVersionId }, extra),
      ),
    ).toEqual({ status: 'invalid' });
  expect(request).not.toHaveBeenCalled();
  for (const status of [200, 503]) {
    const request = vi.fn<typeof fetch>(async () => new Response('x'.repeat(262145), { status }));
    expect(
      await new BotCopyApiClient(request, 'http://localhost:3001', 'http://localhost:3000').preview(
        token,
        workspace.id,
        bot.id,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  }
});
it('keeps the deadline active through an unfinished response body', async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
              init?.signal?.addEventListener('abort', () => controller.error(new Error('Aborted')));
            },
          }),
        ),
    );
    const result = new BotCopyApiClient(
      request,
      'http://localhost:3001',
      'http://localhost:3000',
    ).preview(token, workspace.id, bot.id);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toEqual({ status: 'unavailable' });
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a nonactive copy receipt', async () => {
  expect(
    await client({ bot: { ...copied, lifecycleState: 'archived' } }, 201).api.confirm(
      token,
      workspace.id,
      bot.id,
      { expectedCurrentVersionId: preview.sourceVersionId },
    ),
  ).toEqual({ status: 'unavailable' });
});

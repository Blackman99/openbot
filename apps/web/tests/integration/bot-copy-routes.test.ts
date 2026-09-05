import { expect, it, vi } from 'vitest';
import { botCopyAction, loadBotCopyPage } from '../../src/lib/server/bot-copy-page.js';
import { bot, token, user, workspace } from '../fixtures/bots.js';
import { preview, copied } from '../fixtures/bot-copy.js';
const origin = 'http://localhost:3000';
function context() {
  return {
    fetch: vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/me')) return Response.json({ user, workspace: null });
      if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
      if (path.endsWith(`/bots/${bot.id}`)) return Response.json({ bot });
      if (path.endsWith('/copy-preview')) return Response.json({ preview });
      if (path === '/api/v1/model-connections') return Response.json([]);
      if (path.endsWith('/model-connections'))
        return Response.json({ canManage: false, connections: [] });
      throw new Error('Unexpected request');
    }),
    cookies: {
      get: vi.fn(() => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
    setHeaders: vi.fn(),
  };
}
function request(values: Record<string, string>, requestOrigin = origin) {
  return new Request(`${origin}/copy`, {
    method: 'POST',
    headers: { origin: requestOrigin },
    body: new URLSearchParams(values),
  });
}
it('loads a read-only preview with explicit review fields and creates nothing on cancel', async () => {
  const event = context();
  expect((await loadBotCopyPage(event, workspace.id, bot.id)).preview).toEqual(preview);
  expect(
    event.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
  ).toBe(true);
});
it('forwards exactly the reviewed precondition without reloading it and redirects to the new Bot', async () => {
  const event = context();
  event.fetch.mockResolvedValueOnce(Response.json({ bot: copied }, { status: 201 }));
  await expect(
    botCopyAction(
      {
        ...event,
        request: request({
          expectedCurrentVersionId: preview.sourceVersionId,
          modelChoice: 'keep',
        }),
      },
      workspace.id,
      bot.id,
    ),
  ).rejects.toMatchObject({
    status: 303,
    location: `/app/workspaces/${workspace.id}/bots/${copied.id}`,
  });
  expect(event.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(event.fetch.mock.calls[0]?.[1]?.body))).toEqual({
    expectedCurrentVersionId: preview.sourceVersionId,
  });
});
it('preserves the explicit replacement while refusing malformed forms and wrong browser origins before transport', async () => {
  const event = context();
  const invalidForms: Array<Record<string, string>> = [
    { expectedCurrentVersionId: preview.sourceVersionId },
    {
      expectedCurrentVersionId: preview.sourceVersionId,
      modelChoice: 'keep',
      avatarObjectId: user.id,
    },
    { expectedCurrentVersionId: preview.sourceVersionId, modelChoice: '{"apiKey":"secret"}' },
  ];
  for (const values of invalidForms)
    expect(
      await botCopyAction({ ...event, request: request(values) }, workspace.id, bot.id),
    ).toMatchObject({ status: 400 });
  expect(
    await botCopyAction(
      {
        ...event,
        request: request(
          { expectedCurrentVersionId: preview.sourceVersionId, modelChoice: 'keep' },
          'http://evil.example',
        ),
      },
      workspace.id,
      bot.id,
    ),
  ).toMatchObject({ status: 403 });
  expect(event.fetch).not.toHaveBeenCalled();
  event.fetch.mockResolvedValueOnce(
    Response.json(
      { error: { code: 'bot_model_unavailable', reason: 'not-accessible' } },
      { status: 400 },
    ),
  );
  const choice = JSON.stringify(preview.configuration.modelBinding);
  expect(
    await botCopyAction(
      {
        ...event,
        request: request({
          expectedCurrentVersionId: preview.sourceVersionId,
          modelChoice: choice,
        }),
      },
      workspace.id,
      bot.id,
    ),
  ).toMatchObject({ status: 400, data: { values: { modelChoice: choice }, blocked: false } });
  expect(JSON.parse(String(event.fetch.mock.calls[0]?.[1]?.body)).modelBinding).toEqual(
    preview.configuration.modelBinding,
  );
});
it.each([
  [409, 'bot_version_conflict'],
  [503, 'bot_copy_unavailable'],
  [201, 'malformed_success'],
] as const)(
  'preserves old preconditions and blocks uncertain/conflicting copy retries for %s',
  async (status, code) => {
    const event = context();
    event.fetch.mockResolvedValueOnce(Response.json({ error: { code } }, { status }));
    const result = await botCopyAction(
      {
        ...event,
        request: request({
          expectedCurrentVersionId: preview.sourceVersionId,
          modelChoice: 'keep',
        }),
      },
      workspace.id,
      bot.id,
    );
    expect(result).toMatchObject({
      status: status === 409 ? 409 : 503,
      data: { blocked: true, values: { expectedCurrentVersionId: preview.sourceVersionId } },
    });
    expect(event.cookies.delete).not.toHaveBeenCalled();
  },
);
it.each([401, 403, 500])(
  'clears sessions only on a genuine401 response, status %s',
  async (status) => {
    const event = context();
    event.fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: status === 403 ? 'bot_forbidden' : 'authentication_required' } },
        { status },
      ),
    );
    const result = botCopyAction(
      {
        ...event,
        request: request({
          expectedCurrentVersionId: preview.sourceVersionId,
          modelChoice: 'keep',
        }),
      },
      workspace.id,
      bot.id,
    );
    if (status === 401) {
      await expect(result).rejects.toMatchObject({ status: 303, location: '/sign-in' });
      expect(event.cookies.delete).toHaveBeenCalled();
    } else {
      expect(await result).toMatchObject({ status: status === 403 ? 403 : 503 });
      expect(event.cookies.delete).not.toHaveBeenCalled();
    }
  },
);

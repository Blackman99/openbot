import { expect, it, vi } from 'vitest';
import * as route from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/+page.server.js';
import * as avatar from '../../src/lib/server/avatar-page.js';
import { bot, token, workspace } from '../fixtures/bots.js';

function context(origin = 'http://localhost:3000') {
  const data = new FormData();
  data.set('expectedCurrentVersionId', bot.currentVersion.id);
  data.set(
    'avatar',
    new File([new Uint8Array([137, 80, 78, 71])], 'my.png', { type: 'image/png' }),
  );
  const request = new Request('http://localhost:3000/app/avatar', {
    method: 'POST',
    headers: { origin },
    body: data,
  });
  const cookies = {
    get: vi.fn(() => token),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      version: {
        ...bot.currentVersion,
        id: 'b781b698-0122-4b2d-92bf-0036b947b188',
        number: 2,
        rationale: 'Avatar updated',
        configuration: {
          ...bot.currentVersion.configuration,
          avatarObjectId: 'a781b698-0122-4b2d-92bf-0036b947b188',
        },
      },
    }),
  );
  return {
    request,
    cookies,
    fetch,
    setHeaders: vi.fn(),
    params: { workspaceId: workspace.id, botId: bot.id },
  };
}
it('uploads one bounded file through a trusted browser Origin and passes only bytes and current-version precondition', async () => {
  const ctx = context();
  expect(typeof route.actions?.uploadAvatar).toBe('function');
  // The exported SvelteKit action is the user-visible boundary.
  const result = await route.actions.uploadAvatar(ctx);
  expect(result).toMatchObject({ avatarMessage: 'Avatar updated.' });
  expect(ctx.fetch).toHaveBeenCalledOnce();
  const [url, options] = ctx.fetch.mock.calls[0]!;
  expect(String(url)).toBe(
    `http://localhost:3001/api/v1/workspaces/${workspace.id}/bots/${bot.id}/avatar?expectedCurrentVersionId=${bot.currentVersion.id}`,
  );
  expect(options).toMatchObject({
    method: 'PUT',
    headers: {
      origin: 'http://localhost:3000',
      'content-type': 'image/png',
      cookie: `openbot_session=${token}`,
    },
  });
  expect(options?.body).toBeInstanceOf(ArrayBuffer);
});
it('serves authenticated private avatar bytes without exposing an upstream URL', async () => {
  const ctx = context();
  ctx.fetch.mockResolvedValueOnce(
    new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': 'image/png', 'content-length': '4' },
    }),
  );
  expect(typeof avatar.readAvatar).toBe('function');
  const response = await avatar.readAvatar({
    ...ctx,
    request: new Request(`http://localhost:3000/avatar?versionId=${bot.currentVersion.id}`),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.has('location')).toBe(false);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
});
it('rejects untrusted origins and pre-aborted uploads before forwarding credentials', async () => {
  const foreign = context('https://evil.example');
  expect(await avatar.uploadAvatarAction(foreign)).toMatchObject({ status: 403 });
  expect(foreign.fetch).not.toHaveBeenCalled();
  const ctx = context();
  const controller = new AbortController();
  controller.abort();
  const request = new Request(ctx.request, { signal: controller.signal });
  expect(await avatar.uploadAvatarAction({ ...ctx, request })).toMatchObject({ status: 503 });
  expect(ctx.fetch).not.toHaveBeenCalled();
});
it.each([400, 403, 409, 413, 415, 429, 503])(
  'preserves the session and returns a fixed message for upstream %s',
  async (status) => {
    const ctx = context();
    ctx.fetch.mockResolvedValueOnce(new Response('credential-private-url', { status }));
    const result = await avatar.uploadAvatarAction(ctx);
    expect(result).toMatchObject({ status });
    expect(JSON.stringify(result)).not.toContain('credential');
    expect(ctx.cookies.delete).not.toHaveBeenCalled();
  },
);
it('does not forward duplicate files, unknown fields or oversized images', async () => {
  for (const kind of ['duplicate', 'unknown', 'large']) {
    const ctx = context();
    const form = await ctx.request.formData();
    if (kind === 'duplicate')
      form.append('avatar', new File(['x'], 'x.png', { type: 'image/png' }));
    if (kind === 'unknown') form.append('authorUserId', bot.currentVersion.author.id);
    if (kind === 'large')
      form.set('avatar', new File([new Uint8Array(2097153)], 'large.png', { type: 'image/png' }));
    const request = new Request(ctx.request.url, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: form,
    });
    expect(await avatar.uploadAvatarAction({ ...ctx, request })).toMatchObject({ status: 400 });
    expect(ctx.fetch).not.toHaveBeenCalled();
  }
});
it('bounds private image responses and preserves HEAD authentication without reading bodies', async () => {
  const ctx = context();
  ctx.fetch.mockResolvedValueOnce(
    new Response(new Uint8Array(2097153), { headers: { 'content-type': 'image/png' } }),
  );
  expect((await avatar.readAvatar(ctx)).status).toBe(503);
  ctx.fetch.mockResolvedValueOnce(
    new Response(null, { headers: { 'content-type': 'image/png', 'content-length': '1024' } }),
  );
  const head = await avatar.readAvatar({
    ...ctx,
    request: new Request(ctx.request.url, { method: 'HEAD' }),
  });
  expect(head.status).toBe(200);
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  expect(ctx.fetch.mock.calls[1]?.[1]?.method).toBe('HEAD');
  ctx.fetch.mockResolvedValueOnce(new Response('private', { status: 401 }));
  expect((await avatar.readAvatar(ctx)).status).toBe(401);
  expect(ctx.cookies.delete).toHaveBeenCalled();
});
it('applies the upstream deadline through response bodies for both upload results and image reads', async () => {
  vi.useFakeTimers();
  try {
    for (const mode of ['upload', 'read']) {
      const ctx = context();
      let received!: () => void;
      const started = new Promise<void>((resolve) => {
        received = resolve;
      });
      ctx.fetch.mockImplementationOnce(async (_url, options) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            options?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('cancelled')),
              { once: true },
            );
          },
        });
        received();
        return new Response(stream, {
          headers: { 'content-type': mode === 'upload' ? 'application/json' : 'image/png' },
        });
      });
      const pending = mode === 'upload' ? avatar.uploadAvatarAction(ctx) : avatar.readAvatar(ctx);
      await started;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result).toMatchObject({ status: 503 });
      if (mode === 'upload')
        expect(result).toMatchObject({
          data: {
            avatarError:
              "We couldn't confirm the avatar change. Reload to check the current avatar before trying again.",
          },
        });
      expect(ctx.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    }
  } finally {
    vi.useRealTimers();
  }
});

it.each(['upload', 'remove'])(
  'reports an unconfirmed %s result after transport or successful-response body failures',
  async (action) => {
    for (const failure of ['transport', 'truncated200', 'invalid200']) {
      const ctx = context();
      if (action === 'remove') {
        const form = await ctx.request.formData();
        form.delete('avatar');
        ctx.request = new Request(ctx.request.url, {
          method: 'POST',
          headers: { origin: 'http://localhost:3000' },
          body: form,
        });
      }
      if (failure === 'transport')
        ctx.fetch.mockRejectedValueOnce(new Error('private transport detail'));
      else
        ctx.fetch.mockResolvedValueOnce(
          new Response(failure === 'truncated200' ? '{"version":' : '{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const result = await (action === 'remove'
        ? avatar.removeAvatarAction(ctx)
        : avatar.uploadAvatarAction(ctx));
      expect(result).toMatchObject({
        status: 503,
        data: {
          avatarError:
            "We couldn't confirm the avatar change. Reload to check the current avatar before trying again.",
        },
      });
      expect(ctx.cookies.delete).not.toHaveBeenCalled();
    }
  },
);

import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { BotVersionApiClient } from '../../src/lib/server/bot-version-api.js';
import { bot, token, workspace } from '../fixtures/bots.js';

const version = bot.currentVersion;
const { configuration: _configuration, ...metadata } = version;
const base = `http://localhost:3001/api/v1/workspaces/${workspace.id}/bots/${bot.id}`;
function client(payload: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload, { status }));
  return {
    fetch,
    api: new BotVersionApiClient(fetch, 'http://localhost:3001/', 'http://localhost:3000'),
  };
}
describe('Bot version client', () => {
  it.each([
    [401, 'authentication_required', 'anonymous'],
    [403, 'bot_forbidden', 'forbidden'],
    [403, 'invalid_origin', 'forbidden'],
    [400, 'invalid_bot_version_request', 'invalid'],
    [413, 'invalid_bot_version_request', 'invalid'],
    [415, 'invalid_bot_version_request', 'invalid'],
    [404, 'bot_version_not_found', 'not-found'],
    [409, 'bot_version_conflict', 'conflict'],
    [409, 'bot_avatar_unavailable', 'avatar-unavailable'],
    [500, 'authentication_required', 'unavailable'],
    [503, 'bot_version_unavailable', 'unavailable'],
  ] as const)(
    'maps status %s and %s without exposing upstream data',
    async (status, code, expected) => {
      const { api } = client({ error: { code } }, status);
      expect(
        await api.edit(token, workspace.id, bot.id, {
          expectedCurrentVersionId: version.id,
          changes: {},
        }),
      ).toEqual({ status: expected });
    },
  );
  it.each(['disabled', 'binding-changed', 'capability-unavailable', 'not-accessible'] as const)(
    'preserves the safe model refusal reason %s',
    async (reason) => {
      expect(
        await client({ error: { code: 'bot_model_unavailable', reason } }, 400).api.restore(
          token,
          workspace.id,
          bot.id,
          { expectedCurrentVersionId: version.id, sourceVersionId: bot.id },
        ),
      ).toEqual({ status: 'model-unavailable', reason });
    },
  );
  it('rejects forbidden patch fields, invalid inputs and raw avatar references before transport', async () => {
    const { api, fetch } = client({ version });
    for (const changes of [
      { avatarObjectId: bot.id },
      { limits: { maxTurns: 101 } },
      { limits: { constructor: 1 } },
      { instructions: ' ' },
      {
        modelBinding: {
          ...version.configuration.modelBinding,
          scope: { kind: 'workspace', id: bot.id },
        },
      },
    ])
      expect(
        await api.edit(
          token,
          workspace.id,
          bot.id,
          Object.assign({ expectedCurrentVersionId: version.id, changes: {} }, { changes }),
        ),
      ).toEqual({ status: 'invalid' });
    expect(
      await api.edit(
        token,
        workspace.id,
        bot.id,
        Object.assign({ expectedCurrentVersionId: version.id, changes: {} }, { author: bot.id }),
      ),
    ).toEqual({ status: 'invalid' });
    expect(
      await api.restore(token, workspace.id, bot.id, {
        expectedCurrentVersionId: '../invalid',
        sourceVersionId: version.id,
      }),
    ).toEqual({ status: 'invalid' });
    expect(
      await api.list(token, workspace.id, bot.id, { before: Number.MAX_SAFE_INTEGER, limit: 101 }),
    ).toEqual({ status: 'invalid' });
    expect(await api.get('bad cookie', workspace.id, bot.id, version.id)).toEqual({
      status: 'anonymous',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds success and error bodies and rejects malformed successful mutation receipts', async () => {
    for (const status of [200, 503]) {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response('x'.repeat(1048577), { status }),
      );
      const api = new BotVersionApiClient(fetch, 'http://localhost:3001', 'http://localhost:3000');
      expect(
        await api.edit(token, workspace.id, bot.id, {
          expectedCurrentVersionId: version.id,
          changes: {},
        }),
      ).toEqual({ status: 'unavailable' });
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    }
    const { api } = client({ version: { ...version, createdAt: '2026-02-30T00:00:00.000Z' } });
    expect(await api.get(token, workspace.id, bot.id, version.id)).toEqual({
      status: 'unavailable',
    });
    expect(
      await client({ version }).api.edit(token, workspace.id, bot.id, {
        expectedCurrentVersionId: version.id,
        changes: { instructions: 'A new draft' },
      }),
    ).toEqual({ status: 'unavailable' });
  });
  it('does not forward a request whose caller already cancelled', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ version }));
    const api = new BotVersionApiClient(
      fetch,
      'http://localhost:3001',
      'http://localhost:3000',
      AbortSignal.abort(),
    );
    expect(await api.get(token, workspace.id, bot.id, version.id)).toEqual({
      status: 'unavailable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([200, 409])(
    'keeps the deadline through an actual stalled HTTP %s response body',
    async (status) => {
      let headersSent = false;
      const server = createServer((_request, response) => {
        headersSent = true;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.write('{');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const original = globalThis.setTimeout;
      const timer = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((handler, delay, ...args) =>
          original(handler, delay === 30000 ? 200 : delay, ...args),
        );
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const api = new BotVersionApiClient(
          fetch,
          `http://127.0.0.1:${address.port}`,
          'http://localhost:3000',
        );
        expect(
          await Promise.race([
            api.get(token, workspace.id, bot.id, version.id),
            new Promise((resolve) => {
              watchdog = original(() => resolve('deadline missed'), 1000);
            }),
          ]),
        ).toEqual({ status: 'unavailable' });
        expect(headersSent).toBe(true);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        timer.mockRestore();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it('preserves explicit edit fields and the original current-version precondition without rebinding implicitly', async () => {
    const command = {
      expectedCurrentVersionId: version.id,
      changes: { instructions: '\nMy draft\n  unchanged', limits: { maxTurns: 2 } },
      rationale: 'Review',
    };
    const edited = {
      ...version,
      configuration: {
        ...version.configuration,
        instructions: command.changes.instructions,
        limits: { ...version.configuration.limits, maxTurns: 2 },
      },
    };
    const { fetch, api } = client({ version: edited });
    expect(await api.edit(token, workspace.id, bot.id, command)).toEqual({
      status: 'available',
      value: edited,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${base}/configuration`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify(command),
      headers: { 'content-type': 'application/json' },
    });
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain('modelBinding');
  });
  it('restores by source-version identity, requiring a new result version rather than a pointer rewind', async () => {
    const restored = { ...version, id: bot.id, number: 2, rationale: 'Restored version 1' };
    const { fetch, api } = client({ version: restored });
    const command = { expectedCurrentVersionId: version.id, sourceVersionId: version.id };
    expect(await api.restore(token, workspace.id, bot.id, command)).toEqual({
      status: 'available',
      value: restored,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${base}/versions/restore`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(command),
    });
    expect(await client({ version }).api.restore(token, workspace.id, bot.id, command)).toEqual({
      status: 'unavailable',
    });
  });
  it('validates ordered scalar differences and both requested version IDs', async () => {
    const comparison = {
      fromVersionId: version.id,
      toVersionId: bot.id,
      differences: [
        { field: 'instructions', before: 'Old', after: 'New' },
        { field: 'avatarObjectId', before: null, after: workspace.id },
        { field: 'limits.maxTurns', before: 8, after: 3 },
      ],
    };
    const { fetch, api } = client(comparison);
    expect(await api.compare(token, workspace.id, bot.id, version.id, bot.id)).toEqual({
      status: 'available',
      value: comparison,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${base}/versions/compare?fromVersionId=${version.id}&toVersionId=${bot.id}`,
    );
    for (const bad of [
      { ...comparison, fromVersionId: workspace.id },
      { ...comparison, differences: [...comparison.differences].reverse() },
      { ...comparison, differences: [{ field: 'credentials', before: 'hidden', after: 'new' }] },
      { ...comparison, differences: [{ field: 'limits.maxTurns', before: 8, after: '3' }] },
    ])
      expect(
        await client(bad).api.compare(token, workspace.id, bot.id, version.id, bot.id),
      ).toEqual({ status: 'unavailable' });
  });
  it('reads a strict same-workspace version with canonical UUIDs and bodyless headers', async () => {
    const { fetch, api } = client({ version });
    expect(
      await api.get(
        token,
        workspace.id.toUpperCase(),
        bot.id.toUpperCase(),
        version.id.toUpperCase(),
      ),
    ).toEqual({ status: 'available', value: version });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${base}/versions/${version.id}`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' },
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('content-type')).toBe(false);
  });
  it('reads descending history metadata with the current pointer and older cursor', async () => {
    const history = {
      currentVersionId: version.id,
      versions: [{ ...metadata, number: 2 }],
      nextBefore: 2,
    };
    const { fetch, api } = client(history);
    expect(await api.list(token, workspace.id, bot.id, { before: 3, limit: 1 })).toEqual({
      status: 'available',
      value: history,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${base}/versions?before=3&limit=1`);
  });
  it('rejects injected configuration, invalid ordering and cross-workspace historical bindings', async () => {
    for (const payload of [
      { version: { ...version, secret: 'hidden' } },
      { version: { ...version, id: bot.id } },
      { version: { ...version, author: { ...version.author, email: 'hidden@example.com' } } },
      {
        version: {
          ...version,
          configuration: {
            ...version.configuration,
            modelBinding: {
              ...version.configuration.modelBinding,
              scope: { kind: 'workspace', id: bot.id },
            },
          },
        },
      },
    ])
      expect(await client(payload).api.get(token, workspace.id, bot.id, version.id)).toEqual({
        status: 'unavailable',
      });
    for (const versions of [[version], [metadata, metadata]])
      expect(
        await client({ currentVersionId: version.id, versions, nextBefore: null }).api.list(
          token,
          workspace.id,
          bot.id,
        ),
      ).toEqual({ status: 'unavailable' });
  });
});

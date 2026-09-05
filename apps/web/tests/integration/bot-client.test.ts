import { describe, expect, it, vi } from 'vitest';
import { BotApiClient } from '../../src/lib/server/bot-api.js';
import { bot, input, summary, token, workspace } from '../fixtures/bots.js';
describe('Bot API client', () => {
  it('creates a private owned version and reads scoped summaries and detail without leaking transport data', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ bot }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ bots: [summary] }))
      .mockResolvedValueOnce(Response.json({ bot }));
    const client = new BotApiClient(request, 'http://api:3001/', 'http://localhost:3000');
    expect(await client.create(token, workspace.id, input)).toEqual({
      status: 'available',
      value: bot,
    });
    expect(await client.list(token, workspace.id)).toEqual({
      status: 'available',
      value: [summary],
    });
    expect(await client.get(token, workspace.id, bot.id)).toEqual({
      status: 'available',
      value: bot,
    });
    expect(request.mock.calls[0]).toMatchObject([
      `http://api:3001/api/v1/workspaces/${workspace.id}/bots`,
      {
        method: 'POST',
        body: JSON.stringify(input),
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: `openbot_session=${token}`,
        },
      },
    ]);
    expect(request.mock.calls[1]?.[1]?.headers).not.toHaveProperty('content-type');
  });
  it.each([
    [401, undefined, 'anonymous'],
    [403, { error: { code: 'bot_forbidden' } }, 'forbidden'],
    [403, { error: { code: 'invalid_origin' } }, 'forbidden'],
    [400, { error: { code: 'invalid_bot_request' } }, 'invalid'],
    [500, { error: { code: 'authentication_required' } }, 'unavailable'],
    [403, { error: { code: 'authentication_required' } }, 'unavailable'],
  ])(
    'maps only matching HTTP errors (%i) into safe outcomes',
    async (status, payload, expected) => {
      const request = vi.fn<typeof fetch>(async () =>
        payload === undefined ? new Response(null, { status }) : Response.json(payload, { status }),
      );
      expect(
        await new BotApiClient(request, 'http://api:3001', 'http://localhost:3000').list(
          token,
          workspace.id,
        ),
      ).toEqual({ status: expected });
    },
  );
  it.each(['disabled', 'binding-changed', 'capability-unavailable', 'not-accessible'])(
    'preserves actionable model admission reason %s',
    async (reason) => {
      const request = vi.fn<typeof fetch>(async () =>
        Response.json({ error: { code: 'bot_model_unavailable', reason } }, { status: 400 }),
      );
      expect(
        await new BotApiClient(request, 'http://api:3001', 'http://localhost:3000').create(
          token,
          workspace.id,
          input,
        ),
      ).toEqual({ status: 'model-unavailable', reason });
    },
  );
  it('accepts the API model ID bound of 256 characters without truncation', async () => {
    const value = {
      ...bot,
      currentVersion: {
        ...bot.currentVersion,
        configuration: {
          ...input,
          modelBinding: { ...input.modelBinding, modelId: 'm'.repeat(256) },
        },
      },
    };
    const client = new BotApiClient(
      vi.fn(async () => Response.json({ bot: value })),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.get(token, workspace.id, bot.id)).toEqual({ status: 'available', value });
  });

  it('rejects cross-workspace, secret-bearing, duplicate, invalid UUID and private discovery summaries', async () => {
    for (const bots of [
      [{ ...summary, workspaceId: bot.id }],
      [{ ...summary, password: 'secret' }],
      [summary, summary],
      [{ ...summary, id: 'not-a-uuid' }],
      [{ ...summary, accessRole: null }],
      [bot],
      [{ ...summary, bindingStatus: { state: 'unavailable', reason: 'secret' } }],
    ]) {
      const client = new BotApiClient(
        vi.fn(async () => Response.json({ bots })),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.list(token, workspace.id)).toEqual({ status: 'unavailable' });
    }
  });
  it('admits discovery metadata only and re-reads current availability without retaining a capability badge', async () => {
    const discovered = { ...summary, visibility: 'workspace', accessRole: null };
    const changed = { ...bot, bindingStatus: { state: 'unavailable', reason: 'disabled' } };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ bot: discovered }))
      .mockResolvedValueOnce(Response.json({ bot: changed }))
      .mockResolvedValueOnce(Response.json({ bot: { ...bot, ...discovered } }))
      .mockResolvedValueOnce(Response.json({ bot: summary }));
    const client = new BotApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.get(token, workspace.id, bot.id)).toEqual({
      status: 'available',
      value: discovered,
    });
    expect(await client.get(token, workspace.id, bot.id)).toEqual({
      status: 'available',
      value: changed,
    });
    expect(await client.get(token, workspace.id, bot.id)).toEqual({ status: 'unavailable' });
    expect(await client.get(token, workspace.id, bot.id)).toEqual({ status: 'unavailable' });
  });
  it('rejects mismatched configuration identity, invalid limits and private fields inside detail', async () => {
    for (const configuration of [
      { ...input, name: 'Other' },
      { ...input, limits: { ...input.limits, maxTurns: 1.5 } },
      { ...input, modelBinding: { ...input.modelBinding, apiKey: 'secret' } },
      {
        ...input,
        modelBinding: { ...input.modelBinding, scope: { kind: 'workspace', id: bot.id } },
      },
      { ...input, instructions: '  ' },
    ]) {
      const client = new BotApiClient(
        vi.fn(async () =>
          Response.json({
            bot: { ...bot, currentVersion: { ...bot.currentVersion, configuration } },
          }),
        ),
        'http://api:3001',
        'http://localhost:3000',
      );
      expect(await client.get(token, workspace.id, bot.id)).toEqual({ status: 'unavailable' });
    }
  });
  it('canonicalizes UUID route spelling, rejects unsafe route/session inputs and masks transport failure', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ bot }))
      .mockRejectedValueOnce(new Error('secret upstream'));
    const client = new BotApiClient(request, 'http://api:3001', 'http://localhost:3000');
    expect(await client.get(token, workspace.id.toUpperCase(), bot.id.toUpperCase())).toEqual({
      status: 'available',
      value: bot,
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api:3001/api/v1/workspaces/${workspace.id}/bots/${bot.id}`,
    );
    expect(await client.list('bad; cookie=inject', workspace.id)).toEqual({ status: 'anonymous' });
    expect(await client.get(token, workspace.id, '../users')).toEqual({ status: 'invalid' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await client.list(token, workspace.id)).toEqual({ status: 'unavailable' });
  });
  it('rejects model IDs beyond the provider effective 256-character limit', async () => {
    const value = {
      ...bot,
      currentVersion: {
        ...bot.currentVersion,
        configuration: {
          ...input,
          modelBinding: { ...input.modelBinding, modelId: 'm'.repeat(257) },
        },
      },
    };
    const client = new BotApiClient(
      vi.fn(async () => Response.json({ bot: value })),
      'http://api:3001',
      'http://localhost:3000',
    );
    expect(await client.get(token, workspace.id, bot.id)).toEqual({ status: 'unavailable' });
  });
});

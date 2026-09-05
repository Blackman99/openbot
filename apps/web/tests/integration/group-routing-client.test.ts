import { describe, expect, it, vi } from 'vitest';
import { GroupRoutingApiClient } from '../../src/lib/server/group-routing-api.js';
import { grant, group, setting, token, workspace } from '../fixtures/routing.js';
const base = 'http://api.example';
const origin = 'https://web.example';
describe('Group routing client', () => {
  it('reads only the scoped public setting and sends a CAS update for the exact grant', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ routing: setting }))
      .mockResolvedValueOnce(Response.json({ routing: { ...setting, revision: 4 } }));
    const client = new GroupRoutingApiClient(request, base, origin);
    expect(await client.get(token, workspace.id.toUpperCase(), group.id.toUpperCase())).toEqual({
      status: 'available',
      value: setting,
    });
    expect(
      await client.update(token, workspace.id, group.id, {
        expectedRevision: 3,
        defaultGrantId: grant.id.toUpperCase(),
      }),
    ).toEqual({ status: 'available', value: { ...setting, revision: 4 } });
    expect(request.mock.calls[0]?.[0]).toBe(
      `${base}/api/v1/workspaces/${workspace.id}/groups/${group.id}/routing`,
    );
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
      redirect: 'error',
      headers: { origin, cookie: `openbot_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 3, defaultGrantId: grant.id }),
    });
  });
  it('retains a closed default grant and permits explicit clearing or a same-revision no-op', async () => {
    const closed = { ...setting, defaultLead: { ...setting.defaultLead, closed: true } };
    const cleared = { ...setting, revision: 4, defaultLead: null };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ routing: closed }))
      .mockResolvedValueOnce(Response.json({ routing: cleared }))
      .mockResolvedValueOnce(Response.json({ routing: cleared }));
    const client = new GroupRoutingApiClient(request, base, origin);
    expect(await client.get(token, workspace.id, group.id)).toEqual({
      status: 'available',
      value: closed,
    });
    expect(
      await client.update(token, workspace.id, group.id, {
        expectedRevision: 3,
        defaultGrantId: null,
      }),
    ).toEqual({ status: 'available', value: cleared });
    expect(
      await client.update(token, workspace.id, group.id, {
        expectedRevision: 4,
        defaultGrantId: null,
      }),
    ).toEqual({ status: 'available', value: cleared });
  });
  it.each([
    { ...setting, groupId: workspace.id },
    { ...setting, revision: -1 },
    { ...setting, revision: 0 },
    { ...setting, revision: 2147483648 },
    { ...setting, canManage: 'yes' },
    { ...setting, instructions: 'private' },
    { ...setting, defaultLead: { ...setting.defaultLead, closed: 'false' } },
    {
      ...setting,
      defaultLead: {
        ...setting.defaultLead,
        bot: { ...setting.defaultLead.bot, name: 'x'.repeat(101) },
      },
    },
    {
      ...setting,
      defaultLead: {
        ...setting.defaultLead,
        bot: { ...setting.defaultLead.bot, modelBinding: 'private' },
      },
    },
  ])('rejects malformed, mismatched and private setting projections %#', async (routing) => {
    const client = new GroupRoutingApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ routing })),
      base,
      origin,
    );
    expect(await client.get(token, workspace.id, group.id)).toEqual({ status: 'unavailable' });
  });
  it.each([
    { ...setting, revision: 2 },
    { ...setting, revision: 5 },
    { ...setting, canManage: false },
    { ...setting, defaultLead: { ...setting.defaultLead, closed: true } },
    { ...setting, defaultLead: { ...setting.defaultLead, grantId: workspace.id } },
    { ...setting, defaultLead: null },
  ])('rejects a PATCH receipt that cannot confirm the command %#', async (routing) => {
    const client = new GroupRoutingApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ routing })),
      base,
      origin,
    );
    expect(
      await client.update(token, workspace.id, group.id, {
        expectedRevision: 3,
        defaultGrantId: grant.id,
      }),
    ).toEqual({ status: 'unavailable' });
  });
  it.each([
    [401, 'anything', 'anonymous'],
    [403, 'routing_forbidden', 'forbidden'],
    [403, 'invalid_origin', 'forbidden'],
    [409, 'routing_revision_conflict', 'revision-conflict'],
    [409, 'routing_model_unavailable', 'model-unavailable'],
    [400, 'invalid_routing_request', 'invalid'],
    [413, 'invalid_routing_request', 'invalid'],
    [415, 'invalid_routing_request', 'invalid'],
    [500, 'authentication_required', 'unavailable'],
    [200, 'routing_forbidden', 'unavailable'],
    [403, 'routing_revision_conflict', 'unavailable'],
  ] as const)('maps only real status/code pairs %i %s', async (status, code, expected) => {
    const client = new GroupRoutingApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code } }, { status })),
      base,
      origin,
    );
    expect(await client.get(token, workspace.id, group.id)).toEqual({ status: expected });
  });
  it('validates path identities, revisions and command keys before sending', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new GroupRoutingApiClient(request, base, origin);
    expect(await client.get(token, 'bad', group.id)).toEqual({ status: 'invalid' });
    expect(await client.get(undefined, workspace.id, group.id)).toEqual({ status: 'anonymous' });
    for (const expectedRevision of [-1, 0.5, 2147483647, NaN])
      expect(
        await client.update(token, workspace.id, group.id, {
          expectedRevision,
          defaultGrantId: null,
        }),
      ).toEqual({ status: 'invalid' });
    const forged = { expectedRevision: 3, defaultGrantId: grant.id, actorId: workspace.id };
    expect(await client.update(token, workspace.id, group.id, forged)).toEqual({
      status: 'invalid',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('bounds streamed and advertised responses and rejects invalid UTF-8 without exposing bodies', async () => {
    for (const response of [
      new Response('x'.repeat(16 * 1024 + 1)),
      new Response('{}', { headers: { 'content-length': '16385' } }),
      new Response(new Uint8Array([0xff])),
      Response.json({ routing: setting, secret: 'private' }),
      Response.json(
        { error: { code: 'routing_forbidden', diagnostic: 'private' } },
        { status: 403 },
      ),
    ]) {
      const client = new GroupRoutingApiClient(
        vi.fn<typeof fetch>().mockResolvedValue(response),
        base,
        origin,
      );
      expect(await client.get(token, workspace.id, group.id)).toEqual({ status: 'unavailable' });
    }
  });
  it('cancels a stalled body at the whole-request deadline and on caller abort', async () => {
    vi.useFakeTimers();
    try {
      for (const external of [false, true]) {
        const cancel = vi.fn();
        const request = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(new ReadableStream({ cancel })));
        const controller = new AbortController();
        const pending = new GroupRoutingApiClient(request, base, origin, controller.signal).get(
          token,
          workspace.id,
          group.id,
        );
        await Promise.resolve();
        if (external) controller.abort();
        else await vi.advanceTimersByTimeAsync(30000);
        expect(await pending).toEqual({ status: 'unavailable' });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it('releases a response body rejected by its advertised size', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': '16385' },
    });
    const client = new GroupRoutingApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(response),
      base,
      origin,
    );
    expect(await client.get(token, workspace.id, group.id)).toEqual({ status: 'unavailable' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

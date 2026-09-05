import { describe, expect, it, vi } from 'vitest';
import { RoutingDecisionApiClient } from '../../src/lib/server/routing-decision-api.js';
import { decision, grant, routedTask, token, workspace } from '../fixtures/routing.js';
describe('Selected Task routing evidence client', () => {
  it('performs no request for direct or pre-routing Tasks and reads only one selected receipt', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ routing: decision }));
    const client = new RoutingDecisionApiClient(
      request,
      'http://api.example',
      'https://web.example',
    );
    expect(
      await client.getForTask(token, workspace.id, grant.conversationId, { id: routedTask.id }),
    ).toEqual({ status: 'available', value: null });
    expect(request).not.toHaveBeenCalled();
    expect(
      await client.getForTask(
        token,
        workspace.id.toUpperCase(),
        grant.conversationId.toUpperCase(),
        routedTask,
      ),
    ).toEqual({ status: 'available', value: decision });
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api.example/api/v1/workspaces/${workspace.id}/conversations/${grant.conversationId}/tasks/${routedTask.id}/routing`,
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });
  it.each([
    { routing: { ...decision, reason: 'mention' } },
    { routing: decision, prompt: 'private' },
    { routing: { ...decision, lead: { ...decision.lead, modelBinding: 'private' } } },
  ])(
    'rejects extra data or evidence inconsistent with the admitted Task summary %#',
    async (payload) => {
      const client = new RoutingDecisionApiClient(
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
        'http://api.example',
        'https://web.example',
      );
      expect(
        await client.getForTask(token, workspace.id, grant.conversationId, routedTask),
      ).toEqual({ status: 'unavailable' });
    },
  );
  it.each([
    [401, 'anything', 'anonymous'],
    [403, 'task_forbidden', 'forbidden'],
    [400, 'invalid_task_request', 'invalid'],
    [503, 'task_unavailable', 'unavailable'],
    [500, 'authentication_required', 'unavailable'],
    [403, 'routing_forbidden', 'unavailable'],
  ] as const)('preserves real task boundary failures %i %s', async (status, code, expected) => {
    const client = new RoutingDecisionApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code } }, { status })),
      'http://api.example',
      'https://web.example',
    );
    expect(await client.getForTask(token, workspace.id, grant.conversationId, routedTask)).toEqual({
      status: expected,
    });
  });
  it('validates every URL identity and rejects oversized decision bodies', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
    const client = new RoutingDecisionApiClient(
      request,
      'http://api.example',
      'https://web.example',
    );
    expect(
      await client.getForTask(token, workspace.id, grant.conversationId, {
        ...routedTask,
        id: '../tasks',
      }),
    ).toEqual({ status: 'invalid' });
    expect(request).not.toHaveBeenCalled();
    expect(await client.getForTask(token, workspace.id, grant.conversationId, routedTask)).toEqual({
      status: 'unavailable',
    });
  });
});

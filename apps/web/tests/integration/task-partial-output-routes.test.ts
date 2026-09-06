import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTaskPartialOutput } from '../../src/lib/server/task-partial-output.js';
import { GET } from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/tasks/[taskId]/runs/[runId]/partial-output/+server.js';
import { task, conversation, workspace, token } from '../fixtures/tasks.js';

const params = {
  workspaceId: workspace.id,
  conversationId: conversation.id,
  taskId: task.id,
  runId: task.runs[0]!.id,
};
const partial = {
  conversationId: conversation.id,
  taskId: task.id,
  runId: params.runId,
  partial: { text: 'Saved 🌱', endByte: 10, interrupted: true },
};
function context() {
  const url = new URL(
    `http://localhost:3000/app/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}/runs/${params.runId}/partial-output`,
  );
  return {
    params,
    url,
    request: new Request(url, {
      headers: { authorization: 'Bearer forged', cookie: 'other=secret' },
    }),
    cookies: {
      get: vi.fn(() => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(() => ''),
    },
    fetch: vi.fn<typeof fetch>(async () =>
      Response.json(partial, {
        headers: { 'set-cookie': 'forged=secret', 'x-private-secret': 'secret' },
      }),
    ),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('cancelled partial output BFF', () => {
  it('forwards only the session to the scoped private API and never proxies upstream headers', async () => {
    vi.stubEnv('API_BASE_URL', 'http://private-api:3001');
    expect(GET).toBe(readTaskPartialOutput);
    const ctx = context(),
      response = await readTaskPartialOutput(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(partial);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-private-secret')).toBeNull();
    const [url, init] = ctx.fetch.mock.calls[0]!;
    expect(url).toBe(
      `http://private-api:3001/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/tasks/${task.id}/runs/${params.runId}/partial-output`,
    );
    expect(new Headers(init?.headers).entries().toArray()).toEqual([
      ['cookie', `openbot_session=${token}`],
      ['origin', 'http://localhost:3000'],
    ]);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });
  it.each([401, 403, 409, 503])(
    'maps %i without disclosing a captured prefix or changing a valid revoked-access cookie',
    async (status) => {
      const ctx = context();
      ctx.fetch.mockResolvedValueOnce(
        Response.json(
          { error: { code: status === 409 ? 'task_partial_state_conflict' : 'task_forbidden' } },
          { status },
        ),
      );
      const response = await readTaskPartialOutput(ctx);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('private-prefix');
      expect(ctx.cookies.delete).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    },
  );
  it('rejects extra query input before forwarding credentials and rejects a cross-scope partial response', async () => {
    const ctx = context();
    ctx.url.search = '?runId=other';
    expect((await readTaskPartialOutput(ctx)).status).toBe(400);
    expect(ctx.fetch).not.toHaveBeenCalled();
    ctx.url.search = '';
    ctx.fetch.mockResolvedValueOnce(Response.json({ ...partial, taskId: params.runId }));
    const response = await readTaskPartialOutput(ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(partial.partial.text);
  });
});

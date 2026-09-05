import { describe, expect, it, vi } from 'vitest';

import {
  loadWorkspacePage,
  createWorkspaceAction,
  updateWorkspaceAction,
} from '../../src/lib/server/workspace-page.js';

const token = Buffer.alloc(32, 3).toString('base64url');
const user = { id: 'ada', displayName: 'Ada', email: 'ada@example.com' };
const first = {
  id: 'workspace-a',
  name: 'First',
  description: 'First private context',
  role: 'owner',
};
const second = {
  id: 'workspace-b',
  name: 'Second',
  description: 'Second private context',
  role: 'member',
};
function cookies() {
  return { get: () => token, delete: vi.fn(), getAll: () => [], serialize: vi.fn(), set: vi.fn() };
}
function request() {
  return vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).endsWith('/me')
      ? Response.json({ user, workspace: { id: first.id, name: first.name } })
      : Response.json({ workspaces: [first, second] }),
  );
}

describe('explicit workspace page context', () => {
  it('keeps a valid route on refresh and falls back from invalid or revoked context to an accessible workspace', async () => {
    const event = { cookies: cookies(), fetch: request(), setHeaders: vi.fn() };
    await expect(loadWorkspacePage(event, second.id)).resolves.toEqual({
      user,
      workspace: second,
      workspaces: [first, second],
    });
    await expect(
      loadWorkspacePage({ ...event, fetch: request(), setHeaders: vi.fn() }, second.id),
    ).resolves.toMatchObject({ workspace: second });
    await expect(loadWorkspacePage(event, 'unrelated-workspace')).rejects.toMatchObject({
      status: 303,
      location: '/app/workspaces/workspace-a',
    });
    expect(event.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });

  it('creates from a server action and redirects to the new explicit route', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ workspace: { ...first, id: 'new-workspace' } }, { status: 201 }),
    );
    await expect(
      createWorkspaceAction({
        cookies: cookies(),
        fetch,
        setHeaders: vi.fn(),
        request: new Request('http://localhost:3000/app', {
          method: 'POST',
          body: new URLSearchParams({
            name: 'First',
            description: 'First private context',
            ownerId: 'forged-user',
          }),
        }),
      }),
    ).rejects.toMatchObject({ status: 303, location: '/app/workspaces/new-workspace' });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.body).toBe(
      JSON.stringify({ name: 'First', description: 'First private context' }),
    );
    expect(init?.headers).toMatchObject({
      cookie: `openbot_session=${token}`,
      origin: 'http://localhost:3000',
    });
  });

  it('uses the route workspace ID for setting updates and reports lost permission', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: 'workspace_not_found' } }, { status: 404 }),
    );
    const result = await updateWorkspaceAction(
      {
        cookies: cookies(),
        fetch,
        setHeaders: vi.fn(),
        request: new Request('http://localhost:3000/app', {
          method: 'POST',
          body: new URLSearchParams({ name: 'Updated', workspaceId: 'forged-workspace' }),
        }),
      },
      second.id,
    );
    expect(result).toMatchObject({
      status: 403,
      data: { error: 'You cannot edit this workspace.' },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/v1/workspaces/workspace-b');
  });
});

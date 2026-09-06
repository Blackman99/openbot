import { afterEach, expect, it } from 'vitest';
import { WORKSPACE_EVENT_LIMITS, encodeWorkspaceEventCursor } from '../../src/events/protocol.js';
import { publicTaskFixture } from '../helpers/public-task-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('opens GET /v1/events for Bearer events:read and rejects URL credentials', async () => {
  const f = await publicTaskFixture(cleanup);
  const headers = await f.bearer(['events:read']);
  const created = await f.tokens.create(f.owner.user.id, f.owner.workspace.id, {
    name: 'Events URL probe',
    scopes: ['events:read'],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  for (const request of [
    { url: `/v1/events?token=${created.secret}` },
    { url: `/v1/events?access_token=${created.secret}`, headers },
    { url: `/v1/events?api_key=${created.secret}`, headers },
    { url: '/v1/events' },
    { url: '/v1/events', headers: { authorization: 'Bearer not-a-token' } },
  ]) {
    const denied = await f.publicApp.inject({ method: 'GET', ...request });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: { code: 'invalid_api_token' } });
  }
  const missingScope = await f.publicApp.inject({
    method: 'GET',
    url: '/v1/events',
    headers: await f.bearer(['me:read']),
  });
  expect(missingScope.statusCode).toBe(403);
  expect(missingScope.json()).toEqual({ error: { code: 'insufficient_scope' } });
  const opened = await f.publicApp.inject({ method: 'GET', url: '/v1/events', headers });
  expect(opened.statusCode).toBe(200);
  expect(opened.headers['content-type']).toBe('text/event-stream; charset=utf-8');
  expect(opened.headers['cache-control']).toBe('private, no-store, no-transform');
  expect(opened.headers['x-content-type-options']).toBe('nosniff');
  expect(opened.headers['content-length']).toBeUndefined();
  expect(opened.body.startsWith(': connected\n\n')).toBe(true);
});

it('opens GET /v1/events for a current session cookie without query credentials', async () => {
  const f = await publicTaskFixture(cleanup);
  const denied = await f.publicApp.inject({ method: 'GET', url: '/v1/events' });
  expect(denied.statusCode).toBe(401);
  const opened = await f.publicApp.inject({
    method: 'GET',
    url: '/v1/events',
    headers: f.headers,
  });
  expect(opened.statusCode).toBe(200);
  expect(opened.headers['content-type']).toBe('text/event-stream; charset=utf-8');
  expect(opened.headers['cache-control']).toBe('private, no-store, no-transform');
  expect(opened.body.startsWith(': connected\n\n')).toBe(true);
});

it('replays unread workspace events in order from a stable Last-Event-ID cursor', async () => {
  const f = await publicTaskFixture(cleanup);
  const workspaceId = f.owner.workspace.id;
  const headers = await f.bearer(['events:read']);
  const first = await f.workspaceEvents.append({
    workspaceId,
    type: 'task.updated',
    data: { taskId: '30000000-0000-4000-8000-000000000003', status: 'running' },
  });
  const second = await f.workspaceEvents.append({
    workspaceId,
    type: 'task.terminal',
    data: { taskId: '30000000-0000-4000-8000-000000000003', status: 'completed' },
  });
  const third = await f.workspaceEvents.append({
    workspaceId,
    type: 'task.approval',
    data: { taskId: '30000000-0000-4000-8000-000000000004', status: 'paused' },
  });
  expect(first.sequence).toBe(1);
  expect(second.sequence).toBe(2);
  expect(third.sequence).toBe(3);

  const fromStart = await f.publicApp.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, 0),
    },
  });
  expect(fromStart.statusCode).toBe(200);
  expect(fromStart.headers['content-type']).toBe('text/event-stream; charset=utf-8');
  expect(fromStart.body.startsWith(': connected\n\n')).toBe(true);
  expect(fromStart.body).toBe(`: connected\n\n${first.frame}${second.frame}${third.frame}`);

  const fromFirst = await f.publicApp.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, first.sequence),
    },
  });
  expect(fromFirst.statusCode).toBe(200);
  expect(fromFirst.body).toBe(`: connected\n\n${second.frame}${third.frame}`);
  expect(fromFirst.body).toContain(`id: ${encodeWorkspaceEventCursor({ workspaceId }, 2)}`);
  expect(fromFirst.body).toContain(`id: ${encodeWorkspaceEventCursor({ workspaceId }, 3)}`);
  expect(fromFirst.body).not.toContain(`id: ${encodeWorkspaceEventCursor({ workspaceId }, 1)}`);

  const sessionReplay = await f.publicApp.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...f.headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, second.sequence),
    },
  });
  expect(sessionReplay.statusCode).toBe(200);
  expect(sessionReplay.body).toBe(`: connected\n\n${third.frame}`);
});

it('returns cursor_expired when Last-Event-ID is older than the retention floor', async () => {
  const f = await publicTaskFixture(cleanup);
  const workspaceId = f.owner.workspace.id;
  const headers = await f.bearer(['events:read']);
  const old = new Date(Date.now() - WORKSPACE_EVENT_LIMITS.retentionMs - 60_000);
  const expired = await f.workspaceEvents.append({
    workspaceId,
    type: 'task.updated',
    data: { taskId: '30000000-0000-4000-8000-000000000011', status: 'queued' },
    occurredAt: old,
  });
  const retained = await f.workspaceEvents.append({
    workspaceId,
    type: 'task.terminal',
    data: { taskId: '30000000-0000-4000-8000-000000000011', status: 'failed' },
  });
  await f.workspaceEvents.reclaim(workspaceId);

  const rejected = await f.publicApp.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, expired.sequence - 1),
    },
  });
  expect(rejected.statusCode).toBe(410);
  expect(rejected.json()).toEqual({ error: { code: 'cursor_expired' } });

  const atFloor = await f.publicApp.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, expired.sequence),
    },
  });
  expect(atFloor.statusCode).toBe(200);
  expect(atFloor.body).toBe(`: connected\n\n${retained.frame}`);
});

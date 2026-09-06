import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { registerPublicEventRoutes } from '../../src/events/public-routes.js';
import {
  WORKSPACE_EVENT_LIMITS,
  WorkspaceEventError,
  encodeWorkspaceEventCursor,
} from '../../src/events/protocol.js';
import { WorkspaceEventService } from '../../src/events/service.js';
import { publicTaskFixture } from '../helpers/public-task-fixture.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function eventsApp(
  f: Awaited<ReturnType<typeof publicTaskFixture>>,
  options: {
    idleClosesAfter?: number;
    timing?: { pollMs?: number; heartbeatMs?: number; drainMs?: number };
  } = {},
) {
  const app = Fastify();
  cleanup.push(() => app.close());
  let idle = 0;
  const events = {
    openCursor: (...args: Parameters<WorkspaceEventService['openCursor']>) =>
      f.workspaceEvents.openCursor(...args),
    deliver: async (
      ...args: Parameters<WorkspaceEventService['deliver']>
    ): ReturnType<WorkspaceEventService['deliver']> => {
      const result = await f.workspaceEvents.deliver(...args);
      if (!result.delivered && ++idle >= (options.idleClosesAfter ?? 1))
        throw new WorkspaceEventError('events_unavailable');
      return result;
    },
  } as WorkspaceEventService;
  registerPublicEventRoutes(
    app,
    f.auth,
    f.tokens,
    events,
    options.timing ?? { pollMs: 5, heartbeatMs: 60_000 },
  );
  return app;
}

it('opens GET /v1/events for Bearer events:read and rejects URL credentials', async () => {
  const f = await publicTaskFixture(cleanup);
  const app = await eventsApp(f);
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
    const denied = await app.inject({ method: 'GET', ...request });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: { code: 'invalid_api_token' } });
  }
  const missingScope = await app.inject({
    method: 'GET',
    url: '/v1/events',
    headers: await f.bearer(['me:read']),
  });
  expect(missingScope.statusCode).toBe(403);
  expect(missingScope.json()).toEqual({ error: { code: 'insufficient_scope' } });
  const opened = await app.inject({ method: 'GET', url: '/v1/events', headers });
  expect(opened.statusCode).toBe(200);
  expect(opened.headers['content-type']).toBe('text/event-stream; charset=utf-8');
  expect(opened.headers['cache-control']).toBe('private, no-store, no-transform');
  expect(opened.headers['x-content-type-options']).toBe('nosniff');
  expect(opened.headers['content-length']).toBeUndefined();
  expect(opened.body.startsWith(': connected\n\n')).toBe(true);
});

it('opens GET /v1/events for a current session cookie without query credentials', async () => {
  const f = await publicTaskFixture(cleanup);
  const app = await eventsApp(f);
  const denied = await app.inject({ method: 'GET', url: '/v1/events' });
  expect(denied.statusCode).toBe(401);
  const opened = await app.inject({
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
  const app = await eventsApp(f, { idleClosesAfter: 1 });
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

  const fromStart = await app.inject({
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
  expect(fromStart.body).toContain(first.frame);
  expect(fromStart.body).toContain(second.frame);
  expect(fromStart.body).toContain(third.frame);
  expect(fromStart.body.indexOf(first.frame)).toBeLessThan(fromStart.body.indexOf(second.frame));
  expect(fromStart.body.indexOf(second.frame)).toBeLessThan(fromStart.body.indexOf(third.frame));

  const fromFirst = await app.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, first.sequence),
    },
  });
  expect(fromFirst.statusCode).toBe(200);
  expect(fromFirst.body).toContain(second.frame);
  expect(fromFirst.body).toContain(third.frame);
  expect(fromFirst.body).toContain(`id: ${encodeWorkspaceEventCursor({ workspaceId }, 2)}`);
  expect(fromFirst.body).toContain(`id: ${encodeWorkspaceEventCursor({ workspaceId }, 3)}`);
  expect(fromFirst.body).not.toContain(`id: ${encodeWorkspaceEventCursor({ workspaceId }, 1)}`);

  const sessionReplay = await app.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...f.headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, second.sequence),
    },
  });
  expect(sessionReplay.statusCode).toBe(200);
  expect(sessionReplay.body).toContain(third.frame);
});

it('returns cursor_expired when Last-Event-ID is older than the retention floor', async () => {
  const f = await publicTaskFixture(cleanup);
  const app = await eventsApp(f);
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

  const rejected = await app.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, expired.sequence - 1),
    },
  });
  expect(rejected.statusCode).toBe(410);
  expect(rejected.json()).toEqual({ error: { code: 'cursor_expired' } });

  const atFloor = await app.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, expired.sequence),
    },
  });
  expect(atFloor.statusCode).toBe(200);
  expect(atFloor.body).toContain(retained.frame);
});

it('hides unauthorized group events and closes open streams after token revocation', async () => {
  const f = await publicTaskFixture(cleanup);
  const workspaceId = f.owner.workspace.id;
  const member = await f.addUser('member');
  const owned = await f.readyGroup();
  const foreign = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/groups',
    headers: await f.bearer(['groups:write']),
    payload: { name: 'Foreign group' },
  });
  const foreignGroupId = foreign.json().group.id as string;
  await f.pool.query(
    "INSERT INTO group_memberships(group_id,user_id,role,created_at) VALUES($1,$2,'member',$3)",
    [owned.groupId, member.id, new Date()],
  );
  const memberToken = await f.tokens.create(member.id, workspaceId, {
    name: 'Member events',
    scopes: ['events:read'],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const visible = await f.workspaceEvents.append({
    workspaceId,
    groupId: owned.groupId,
    type: 'task.terminal',
    data: { taskId: '30000000-0000-4000-8000-000000000021', status: 'completed' },
  });
  const hidden = await f.workspaceEvents.append({
    workspaceId,
    groupId: foreignGroupId,
    type: 'task.cancelled',
    data: { taskId: '30000000-0000-4000-8000-000000000022', status: 'cancelled' },
  });
  const app = await eventsApp(f, { idleClosesAfter: 1 });
  const scoped = await app.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      authorization: `Bearer ${memberToken.secret}`,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, 0),
    },
  });
  expect(scoped.statusCode).toBe(200);
  expect(scoped.body).toContain(visible.frame);
  expect(scoped.body).not.toContain(hidden.frame);
  expect(scoped.body).not.toContain(foreignGroupId);

  let idle = 0;
  const live = Fastify();
  cleanup.push(() => live.close());
  registerPublicEventRoutes(
    live,
    f.auth,
    f.tokens,
    {
      openCursor: (...args: Parameters<WorkspaceEventService['openCursor']>) =>
        f.workspaceEvents.openCursor(...args),
      deliver: async (...args: Parameters<WorkspaceEventService['deliver']>) => {
        const result = await f.workspaceEvents.deliver(...args);
        if (!result.delivered) {
          idle++;
          if (idle === 1) await f.tokens.revoke(member.id, workspaceId, memberToken.token.id);
        }
        return result;
      },
    } as WorkspaceEventService,
    { pollMs: 5, heartbeatMs: 60_000 },
  );
  const revoked = await live.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      authorization: `Bearer ${memberToken.secret}`,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, visible.sequence),
    },
  });
  expect(revoked.statusCode).toBe(200);
  expect(revoked.body.startsWith(': connected\n\n')).toBe(true);
  expect(revoked.body).toContain('invalid_api_token');
  expect(revoked.body).not.toContain(hidden.frame);
});

it('streams domain terminal, cancellation, approval and budget events with heartbeats', async () => {
  const f = await publicTaskFixture(cleanup);
  const workspaceId = f.owner.workspace.id;
  const { groupId } = await f.readyGroup();
  const terminal = await f.workspaceEvents.append({
    workspaceId,
    groupId,
    type: 'task.terminal',
    data: { taskId: '30000000-0000-4000-8000-000000000031', status: 'completed' },
  });
  const cancelled = await f.workspaceEvents.append({
    workspaceId,
    groupId,
    type: 'task.cancelled',
    data: { taskId: '30000000-0000-4000-8000-000000000032', status: 'cancelled' },
  });
  const approval = await f.workspaceEvents.append({
    workspaceId,
    groupId,
    type: 'task.approval',
    data: { taskId: '30000000-0000-4000-8000-000000000033', status: 'waiting_approval' },
  });
  const budget = await f.workspaceEvents.append({
    workspaceId,
    groupId,
    type: 'task.budget_exhausted',
    data: { taskId: '30000000-0000-4000-8000-000000000034', status: 'waiting_budget' },
  });
  const app = Fastify();
  cleanup.push(() => app.close());
  let reads = 0;
  registerPublicEventRoutes(
    app,
    f.auth,
    f.tokens,
    {
      openCursor: (...args: Parameters<WorkspaceEventService['openCursor']>) =>
        f.workspaceEvents.openCursor(...args),
      deliver: async (...args: Parameters<WorkspaceEventService['deliver']>) => {
        const result = await f.workspaceEvents.deliver(...args);
        reads++;
        // Allow one idle after catch-up so the delivery loop can emit a heartbeat.
        if (!result.delivered && reads > 5) throw new WorkspaceEventError('events_unavailable');
        return result;
      },
    } as WorkspaceEventService,
    { pollMs: 1, heartbeatMs: 0 },
  );
  const opened = await app.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...(await f.bearer(['events:read'])),
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, 0),
    },
  });
  expect(opened.statusCode).toBe(200);
  expect(opened.body).toContain(terminal.frame);
  expect(opened.body).toContain(cancelled.frame);
  expect(opened.body).toContain(approval.frame);
  expect(opened.body).toContain(budget.frame);
  expect(opened.body).toContain(': heartbeat\n\n');
  expect(opened.body).toContain('event: task.terminal');
  expect(opened.body).toContain('event: task.cancelled');
  expect(opened.body).toContain('event: task.approval');
  expect(opened.body).toContain('event: task.budget_exhausted');
});

it('disconnects a slow consumer and allows resume from the last confirmed event id', async () => {
  const f = await publicTaskFixture(cleanup);
  const workspaceId = f.owner.workspace.id;
  const first = await f.workspaceEvents.append({
    workspaceId,
    type: 'task.updated',
    data: { taskId: '30000000-0000-4000-8000-000000000041', status: 'running' },
  });
  const second = await f.workspaceEvents.append({
    workspaceId,
    type: 'task.terminal',
    data: { taskId: '30000000-0000-4000-8000-000000000041', status: 'completed' },
  });
  const headers = await f.bearer(['events:read']);
  let delivered = 0;
  const slow = Fastify();
  cleanup.push(() => slow.close());
  registerPublicEventRoutes(
    slow,
    f.auth,
    f.tokens,
    {
      openCursor: (...args: Parameters<WorkspaceEventService['openCursor']>) =>
        f.workspaceEvents.openCursor(...args),
      deliver: async (admission, workspace, cursor, enqueue) => {
        const result = await f.workspaceEvents.deliver(admission, workspace, cursor, (frame) => {
          delivered++;
          if (delivered === 1) enqueue(frame);
          else throw new WorkspaceEventError('slow_consumer');
        });
        return result;
      },
    } as WorkspaceEventService,
    { pollMs: 5, heartbeatMs: 60_000, drainMs: 5 },
  );
  const blocked = await slow.inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, 0),
    },
  });
  expect(blocked.statusCode).toBe(200);
  expect(blocked.body).toContain(first.frame);
  expect(blocked.body).toContain('slow_consumer');
  expect(blocked.body).not.toContain(second.frame);

  const resumed = await (
    await eventsApp(f, { idleClosesAfter: 1 })
  ).inject({
    method: 'GET',
    url: '/v1/events',
    headers: {
      ...headers,
      'last-event-id': encodeWorkspaceEventCursor({ workspaceId }, first.sequence),
    },
  });
  expect(resumed.statusCode).toBe(200);
  expect(resumed.body).toContain(second.frame);
  expect(resumed.body).not.toContain(`id: ${encodeWorkspaceEventCursor({ workspaceId }, 1)}`);
});

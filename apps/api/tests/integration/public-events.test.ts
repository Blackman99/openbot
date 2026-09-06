import { afterEach, expect, it } from 'vitest';
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

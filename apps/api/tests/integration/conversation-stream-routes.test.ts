import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { registerConversationStreamRoutes } from '../../src/conversations/stream-routes.js';
import { ConversationStreamService } from '../../src/conversations/stream-service.js';
import {
  ConversationStreamError,
  encodeConversationStreamCursor,
} from '../../src/conversations/stream-protocol.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('private conversation SSE routes', () => {
  it('requires a current session and valid scoped cursor, then sends bounded typed frames without response buffering', async () => {
    const f = await taskFixture(cleanup),
      streams = new ConversationStreamService(f.pool),
      app = Fastify();
    cleanup.push(() => app.close());
    let reads = 0;
    registerConversationStreamRoutes(app, {
      bootstrap: (...args) => streams.bootstrap(...args),
      check: (...args) => streams.check(...args),
      deliver: (...args) => {
        if (++reads === 3) throw new ConversationStreamError('conversation_stream_unavailable');
        return streams.deliver(...args);
      },
    });
    const scope = { workspaceId: f.owner.workspace.id, conversationId: f.conversation.id },
      url = `/api/v1/workspaces/${scope.workspaceId}/conversations/${scope.conversationId}/events`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    for (const cursor of [undefined, 'invalid', encodeConversationStreamCursor(scope, 3)]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { ...f.headers, ...(cursor ? { 'last-event-id': cursor } : {}) },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: 'invalid_stream_cursor' } });
    }
    const bootstrap = await app.inject({
      method: 'GET',
      url: url + '/bootstrap',
      headers: f.headers,
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().cursor).toBe(encodeConversationStreamCursor(scope, 2));
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { ...f.headers, 'last-event-id': encodeConversationStreamCursor(scope, 0) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('private, no-store, no-transform');
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.body.startsWith(': connected\n\n')).toBe(true);
    expect(response.body.match(/^id:/gmu)).toHaveLength(2);
    expect(response.body).toContain('event: message.changed');
    expect(response.body).toContain('event: task.run.updated');
    expect(response.body).toContain('event: stream.control');
    expect(response.body).not.toContain('Explain the evidence.');
  });
});

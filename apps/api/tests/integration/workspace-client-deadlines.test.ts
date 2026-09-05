import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { MemberApiClient } from '../../../web/src/lib/server/member-api.js';
import { InvitationApiClient } from '../../../web/src/lib/server/invitation-api.js';
import { GroupApiClient } from '../../../web/src/lib/server/group-api.js';

it.each(['members', 'invitations', 'groups'] as const)(
  'keeps the %s client deadline active while a real HTTP response body stalls',
  async (resource) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(`{"${resource}":[`);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    const originalTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) =>
        originalTimeout(callback, delay === 30_000 ? 200 : delay, ...args),
      );
    let headersReceived = false;
    const request: typeof fetch = async (...args) => {
      const response = await fetch(...args);
      headersReceived = true;
      return response;
    };
    const Client =
      resource === 'members'
        ? MemberApiClient
        : resource === 'groups'
          ? GroupApiClient
          : InvitationApiClient;
    const pending = new Client(
      request,
      `http://127.0.0.1:${address.port}`,
      'http://localhost:3000',
    ).list('a'.repeat(43), 'workspace-id');
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<'deadline-missed'>((resolve) => {
          watchdog = originalTimeout(() => resolve('deadline-missed'), 800);
        }),
      ]);
      expect(headersReceived).toBe(true);
      expect(result).toEqual({ status: 'unavailable' });
    } finally {
      if (watchdog) clearTimeout(watchdog);
      timeoutSpy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pending;
    }
  },
);

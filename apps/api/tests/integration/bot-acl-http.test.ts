import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BotAclApiClient } from '../../../web/src/lib/server/bot-acl-api.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';

describe('real HTTP Bot permission client and API contract', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  it('round-trips grant, list, role, discovery and bodyless revoke with the actual scoped API', async () => {
    const f = await botAclFixture(cleanup),
      target = await f.addUser();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new BotAclApiClient(fetch, address, f.headers.origin);
    const session = f.headers.cookie.slice('openbot_session='.length),
      targetSession = target.headers.cookie.slice('openbot_session='.length);
    const workspaceId = f.owner.workspace.id.toUpperCase(),
      botId = f.bot.id.toUpperCase();
    const listed = await client.list(session, workspaceId, botId);
    expect(listed.status).toBe('available');
    if (listed.status !== 'available') throw new Error('Owner list unavailable');
    expect(listed.value).toHaveLength(1);
    const granted = await client.grant(session, workspaceId, botId, target.id.toUpperCase());
    expect(granted).toMatchObject({
      status: 'available',
      value: { user: { id: target.id }, role: 'user', hasWorkspaceAccess: true },
    });
    expect(await client.grant(session, workspaceId, botId, target.id)).toEqual({
      status: 'conflict',
    });
    expect(await client.changeRole(session, workspaceId, botId, target.id, 'editor')).toMatchObject(
      { status: 'available', value: { role: 'editor' } },
    );
    expect(await client.list(targetSession, workspaceId, botId)).toEqual({ status: 'forbidden' });
    expect(await client.setVisibility(session, workspaceId, botId, 'workspace')).toEqual({
      status: 'available',
      value: 'workspace',
    });
    expect(await client.changeRole(session, workspaceId, botId, target.id, 'owner')).toMatchObject({
      status: 'available',
      value: { role: 'owner' },
    });
    expect(
      await client.changeRole(session, workspaceId, botId, f.owner.user.id, 'editor'),
    ).toMatchObject({ status: 'available', value: { role: 'editor' } });
    expect(await client.list(session, workspaceId, botId)).toEqual({ status: 'forbidden' });
    expect(
      await client.changeRole(targetSession, workspaceId, botId, f.owner.user.id, 'owner'),
    ).toMatchObject({ status: 'available', value: { role: 'owner' } });
    expect(await client.revoke(targetSession, workspaceId, botId, target.id)).toEqual({
      status: 'available',
      value: undefined,
    });
    expect(await client.revoke(session, workspaceId, botId, f.owner.user.id)).toEqual({
      status: 'last-owner',
    });
    expect(await client.revoke(session, workspaceId, botId, randomUUID())).toEqual({
      status: 'not-found',
    });
    expect(await client.list(randomBytes(32).toString('base64url'), workspaceId, botId)).toEqual({
      status: 'anonymous',
    });
    const untrusted = new BotAclApiClient(fetch, address, 'https://untrusted.example');
    expect(await untrusted.setVisibility(session, workspaceId, botId, 'private')).toEqual({
      status: 'forbidden',
    });
  });
  it('maps a real safe database-error response to unavailable without exposing audit internals', async () => {
    const f = await botAclFixture(cleanup, {
      onAclQuery: (statement) => {
        if (statement.includes('INSERT INTO audit_events'))
          throw new Error('private audit internals');
      },
    });
    const target = await f.addUser();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new BotAclApiClient(fetch, address, f.headers.origin);
    expect(
      await client.grant(
        f.headers.cookie.slice('openbot_session='.length),
        f.owner.workspace.id,
        f.bot.id,
        target.id,
      ),
    ).toEqual({ status: 'unavailable' });
  });
});

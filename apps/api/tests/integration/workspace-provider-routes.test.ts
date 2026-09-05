import { WorkspaceProviderApiClient } from '../../../web/src/lib/server/workspace-provider-api.js';
import { newDb } from 'pg-mem';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { InvitationService } from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const origin = 'http://localhost:3000';
const input = {
  protocol: 'anthropic-messages',
  name: 'Shared model',
  baseUrl: 'https://models.example/v1',
  modelId: 'model',
  apiKey: 'workspace-api-secret',
  headers: { 'x-secret': 'workspace-header-secret' },
};
async function fixture() {
  const pool = new (newDb({ noAstCoverageCheck: true }).adapters.createPg().Pool)();
  cleanup.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$test-only',
  });
  const owner = await auth.setup({
    displayName: 'Owner',
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });
  const probe = {
    run: vi.fn(async () => ({
      testedAt: new Date().toISOString(),
      text: {
        ok: true,
        code: 'passed',
        raw: 'workspace-api-secret workspace-header-secret internal-evidence',
      },
      action: { ok: false, code: 'provider_action_unsupported', raw: 'internal-evidence' },
    })),
  };
  const app = buildApp({
    auth,
    members: new WorkspaceMemberService(new PostgresWorkspaceMemberRepository(pool)),
    invitations: new InvitationService(
      new PostgresInvitationRepository(pool),
      () => new Date(),
      async () => '$argon2id$test-only',
    ),
    providers: new ProviderConnections(
      new PostgresProviderRepository(pool),
      new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      probe,
    ),
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  const ownerHeaders = { cookie: `openbot_session=${owner.sessionToken}`, origin };
  const workspaceId = owner.workspace.id;
  const invitation = (
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/invitations`,
      headers: ownerHeaders,
      payload: { email: 'member@example.com', role: 'member', expiresInDays: 1 },
    })
  ).json();
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/v1/invitations/accept',
    headers: { origin },
    payload: {
      token: invitation.token,
      email: 'member@example.com',
      displayName: 'Member',
      password: 'correct horse battery staple',
    },
  });
  expect(accepted.statusCode).toBe(201);
  const memberHeaders = { cookie: String(accepted.headers['set-cookie']).split(';')[0]!, origin };
  return {
    app,
    pool,
    owner,
    ownerHeaders,
    memberHeaders,
    memberId: accepted.json<{ user: { id: string } }>().user.id,
    workspaceId,
    probe,
    path: `/api/v1/workspaces/${workspaceId}/model-connections`,
  };
}

it('serves the shared lifecycle with separate member usage and administrator management permissions', async () => {
  const { app, pool, ownerHeaders, memberHeaders, path, probe, workspaceId, memberId } =
    await fixture();
  expect((await app.inject({ url: path })).statusCode).toBe(401);
  const created = await app.inject({
    method: 'POST',
    url: path,
    headers: ownerHeaders,
    payload: input,
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({
    canManage: true,
    connection: { protocol: 'anthropic-messages', settings: { anthropicVersion: '2023-06-01' } },
  });
  expect(created.body).not.toMatch(/workspace-api-secret|workspace-header-secret/u);
  const id = created.json().connection.id;
  const list = await app.inject({ url: path, headers: memberHeaders });
  expect(list.statusCode).toBe(200);
  expect(list.headers['cache-control']).toBe('private, no-store');
  expect(list.json()).toMatchObject({
    canManage: false,
    connections: [{ id, availability: 'available' }],
  });
  expect(list.body).not.toMatch(
    /settings|raw|baseUrl|apiKey|headerNames|internal-evidence|sealed/u,
  );
  for (const [method, url, payload] of [
    ['POST', path, input],
    ['PUT', `${path}/${id}`, { apiKey: 'override' }],
    ['PATCH', `${path}/${id}`, { enabled: false }],
  ] as const) {
    const denied = await app.inject({ method, url, headers: memberHeaders, payload });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: { code: 'workspace_forbidden' } });
  }
  expect(probe.run).toHaveBeenCalledTimes(1);
  const tested = await app.inject({
    method: 'POST',
    url: `${path}/${id}/test`,
    headers: memberHeaders,
  });
  expect(tested.statusCode).toBe(200);
  expect(tested.body).not.toMatch(
    /raw|internal-evidence|workspace-api-secret|workspace-header-secret/u,
  );
  expect(tested.json()).toMatchObject({
    report: { text: { ok: true }, action: { ok: false, code: 'provider_action_unsupported' } },
  });
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `${path}/${id}`,
        headers: ownerHeaders,
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({ method: 'POST', url: `${path}/${id}/test`, headers: memberHeaders })
    ).json(),
  ).toEqual({ error: { code: 'connection_disabled' } });
  expect((await app.inject({ url: `${path}/${id}`, headers: memberHeaders })).json()).toMatchObject(
    { connection: { id, availability: 'unavailable' } },
  );
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${workspaceId}/members/${memberId}`,
        headers: ownerHeaders,
      })
    ).statusCode,
  ).toBe(204);
  expect((await app.inject({ url: '/api/v1/me', headers: memberHeaders })).json()).toMatchObject({
    workspace: null,
  });
  for (const url of [path, `${path}/${id}`, `${path}/${id}/test`])
    expect(
      (
        await app.inject({
          method: url.endsWith('/test') ? 'POST' : 'GET',
          url,
          headers: memberHeaders,
        })
      ).statusCode,
    ).toBe(403);
  const audits = await pool.query(
    "SELECT actor_user_id,metadata FROM audit_events WHERE event_type LIKE 'provider.%'",
  );
  expect(audits.rows).toHaveLength(3);
  expect(audits.rows[1]).toMatchObject({
    actor_user_id: memberId,
    metadata: { workspaceId, connectionId: id },
  });
  expect(JSON.stringify(audits.rows)).not.toMatch(
    /workspace-api-secret|workspace-header-secret|internal-evidence/u,
  );
});

it('rejects credential overrides, untrusted origins, malformed bodies and cross-workspace IDs without exposing secrets', async () => {
  const { app, ownerHeaders, memberHeaders, path, probe } = await fixture();
  const created = await app.inject({
    method: 'POST',
    url: path,
    headers: ownerHeaders,
    payload: input,
  });
  const id = created.json().connection.id;
  const override = await app.inject({
    method: 'POST',
    url: `${path}/${id}/test`,
    headers: memberHeaders,
    payload: { apiKey: 'override-secret' },
  });
  expect(override.statusCode).toBe(400);
  expect(override.json()).toEqual({ error: { code: 'invalid_connection' } });
  expect(probe.run).toHaveBeenCalledTimes(1);
  const forbidden = await app.inject({
    method: 'PUT',
    url: `${path}/${id}`,
    headers: { ...ownerHeaders, origin: 'https://untrusted.example' },
    payload: input,
  });
  expect(forbidden.statusCode).toBe(403);
  const malformed = await app.inject({
    method: 'POST',
    url: path,
    headers: { ...ownerHeaders, 'content-type': 'application/json' },
    payload: 'malformed-secret',
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('malformed-secret');
  expect(malformed.headers['cache-control']).toBe('private, no-store');
  expect(
    (
      await app.inject({
        url: `/api/v1/workspaces/00000000-0000-4000-8000-000000000000/model-connections/${id}`,
        headers: ownerHeaders,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ url: `/api/v1/model-connections/${id}`, headers: ownerHeaders }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        url: `${path}/00000000-0000-4000-8000-000000000000`,
        headers: memberHeaders,
      })
    ).statusCode,
  ).toBe(404);
});

it('accepts the workspace Web client over real HTTP for all protocols and bodyless member usage', async () => {
  const { app, owner, memberHeaders, workspaceId } = await fixture();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const client = new WorkspaceProviderApiClient(fetch, address, origin);
  const memberToken = memberHeaders.cookie.slice('openbot_session='.length);
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
    const saved = await client.save(owner.sessionToken, workspaceId, { ...input, protocol });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('Expected saved connection');
    const id = saved.value.connection.id;
    expect(await client.get(memberToken, workspaceId, id)).toMatchObject({
      ok: true,
      value: { canManage: false, connection: { id, protocol } },
    });
    expect(await client.test(memberToken, workspaceId, id)).toMatchObject({
      ok: true,
      value: { report: { text: { ok: true }, action: { ok: false } } },
    });
    expect(await client.update(memberToken, workspaceId, id, { apiKey: 'override' })).toEqual({
      ok: false,
      code: 'workspace_forbidden',
    });
    expect(
      await client.update(owner.sessionToken, workspaceId, id, { modelId: 'changed' }),
    ).toMatchObject({ ok: true, value: { connection: { modelId: 'changed' } } });
    expect(await client.disable(owner.sessionToken, workspaceId, id)).toMatchObject({
      ok: true,
      value: { connection: { availability: 'unavailable' } },
    });
    expect(await client.test(memberToken, workspaceId, id)).toEqual({
      ok: false,
      code: 'connection_disabled',
    });
  }
  const listed = await client.list(memberToken, workspaceId);
  expect(listed).toMatchObject({
    ok: true,
    value: { canManage: false, connections: expect.any(Array) },
  });
  if (!listed.ok) throw new Error('Expected member list');
  expect(listed.value.connections).toHaveLength(3);
});

it('grants and revokes administrator management through the member API without rebinding stored credentials', async () => {
  const { app, ownerHeaders, memberHeaders, workspaceId, memberId, path, probe } = await fixture();
  const created = await app.inject({
    method: 'POST',
    url: path,
    headers: ownerHeaders,
    payload: input,
  });
  const id = created.json().connection.id;
  const rolePath = `/api/v1/workspaces/${workspaceId}/members/${memberId}`;
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: rolePath,
        headers: ownerHeaders,
        payload: { role: 'administrator' },
      })
    ).statusCode,
  ).toBe(200);
  const updated = await app.inject({
    method: 'PUT',
    url: `${path}/${id}`,
    headers: memberHeaders,
    payload: { modelId: 'admin-edited-model' },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({
    canManage: true,
    connection: { modelId: 'admin-edited-model', settings: { apiKeyConfigured: true } },
  });
  expect(probe.run).toHaveBeenLastCalledWith(
    expect.objectContaining({
      apiKey: 'workspace-api-secret',
      headers: { 'x-secret': 'workspace-header-secret' },
    }),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(
    (
      await app.inject({
        method: 'POST',
        url: path,
        headers: memberHeaders,
        payload: { ...input, protocol: 'openai-chat' },
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `${path}/${id}`,
        headers: memberHeaders,
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: rolePath,
        headers: ownerHeaders,
        payload: { role: 'member' },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${path}/${id}`,
        headers: memberHeaders,
        payload: { apiKey: 'must-not-save' },
      })
    ).statusCode,
  ).toBe(403);
  const view = await app.inject({ url: path, headers: memberHeaders });
  expect(view.json()).toMatchObject({ canManage: false });
  expect(view.body).not.toMatch(/settings|apiKey|headerNames|raw|sealed/u);
});

it('treats UUID spelling as one workspace and connection identity when encrypting and using credentials', async () => {
  const { app, pool, ownerHeaders, memberHeaders, workspaceId, memberId, path } = await fixture();
  const upperPath = path.replace(workspaceId, workspaceId.toUpperCase());
  const created = await app.inject({
    method: 'POST',
    url: upperPath,
    headers: ownerHeaders,
    payload: input,
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().connection.id;
  expect(
    (await app.inject({ method: 'POST', url: `${path}/${id}/test`, headers: memberHeaders }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${workspaceId}/members/${memberId}`,
        headers: ownerHeaders,
        payload: { role: 'administrator' },
      })
    ).statusCode,
  ).toBe(200);
  const changed = await app.inject({
    method: 'PUT',
    url: `${upperPath}/${id.toUpperCase()}`,
    headers: memberHeaders,
    payload: { name: 'Edited through equivalent UUIDs' },
  });
  expect(changed.statusCode).toBe(200);
  expect(changed.json()).toMatchObject({
    connection: { id, settings: { id, apiKeyConfigured: true } },
  });
  expect(
    (await app.inject({ method: 'POST', url: `${path}/${id}/test`, headers: ownerHeaders }))
      .statusCode,
  ).toBe(200);
  const canonical = await app.inject({
    method: 'POST',
    url: path,
    headers: memberHeaders,
    payload: input,
  });
  const canonicalId = canonical.json().connection.id;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${upperPath}/${canonicalId.toUpperCase()}/test`,
        headers: ownerHeaders,
      })
    ).statusCode,
  ).toBe(200);
  const audits = await pool.query(
    "SELECT metadata FROM audit_events WHERE event_type LIKE 'provider.%'",
  );
  expect(
    audits.rows.every(
      (row: { metadata: { workspaceId: string } }) => row.metadata.workspaceId === workspaceId,
    ),
  ).toBe(true);
});

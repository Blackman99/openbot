import { createServer } from 'node:http';
import { ProtocolConnectionProbe } from '../../src/providers/protocols.js';
import { randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import { ModelConnectionProbe } from '../../src/providers/model-probe.js';
import type { ModelAdapter } from '../../src/providers/model-events.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end();
});
const input = {
  protocol: 'openai-responses',
  name: 'Shared reasoner',
  baseUrl: 'https://models.example/v1',
  modelId: 'reasoner',
  apiKey: 'workspace-api-secret',
  headers: { 'x-secret': 'workspace-header-secret' },
};
const report = {
  testedAt: '2030-01-02T00:00:00.000Z',
  text: { ok: true, code: 'passed', raw: 'internal raw evidence' },
  action: { ok: false, code: 'provider_action_unsupported', raw: '{}' },
};
async function fixture() {
  const pool = new (newDb({ noAstCoverageCheck: true }).adapters.createPg().Pool)();
  pools.push(pool);
  await migrateDatabase(pool, { installPostgresGuards: false });
  const owner = randomUUID();
  const member = randomUUID();
  const other = randomUUID();
  const workspaceId = randomUUID();
  for (const user of [owner, member, other])
    await pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
      [user, `${user}@example.com`, 'Person'],
    );
  await pool.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
    workspaceId,
    'Shared workspace',
  ]);
  for (const [user, role] of [
    [owner, 'owner'],
    [member, 'member'],
  ])
    await pool.query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
      [workspaceId, user, role],
    );
  const probe = { run: vi.fn(async () => report) };
  const service = new ProviderConnections(
    new PostgresProviderRepository(pool),
    new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
    probe,
  );
  return { pool, owner, member, other, workspaceId, probe, service };
}

it('creates scoped encrypted connections and exposes only member-safe model metadata', async () => {
  const { pool, owner, member, other, workspaceId, service, probe } = await fixture();
  const workspace = service.inWorkspace(workspaceId);
  const created = await workspace.save(owner, input);
  expect(created).toMatchObject({ name: 'Shared reasoner', protocol: 'openai-responses' });
  expect(await workspace.view(member)).toEqual({
    canManage: false,
    connections: [
      {
        id: created.id,
        name: 'Shared reasoner',
        protocol: 'openai-responses',
        modelId: 'reasoner',
        availability: 'available',
        lastProbe: {
          testedAt: report.testedAt,
          text: { ok: true, code: 'passed' },
          action: { ok: false, code: 'provider_action_unsupported' },
        },
      },
    ],
  });
  expect((await workspace.view(owner)).canManage).toBe(true);
  await expect(workspace.save(member, input)).rejects.toThrow('workspace_forbidden');
  await expect(workspace.view(other)).rejects.toThrow('workspace_forbidden');
  expect(probe.run).toHaveBeenCalledTimes(1);
  expect(await service.list(owner)).toEqual([]);
  const rows = await pool.query('SELECT * FROM workspace_model_connections');
  expect(rows.rows[0].workspace_id).toBe(workspaceId);
  expect(JSON.stringify(rows.rows)).not.toMatch(/workspace-api-secret|workspace-header-secret/u);
  expect((await pool.query('SELECT actor_user_id,metadata FROM audit_events')).rows).toEqual([
    { actor_user_id: owner, metadata: { workspaceId, connectionId: created.id } },
  ]);
});

it('shares credentials across administrators, rejects member edits, and retains disabled connection identity', async () => {
  const { pool, owner, member, workspaceId, service, probe } = await fixture();
  const workspace = service.inWorkspace(workspaceId);
  const created = await workspace.save(owner, input);
  await expect(workspace.update(member, created.id, { name: 'Forbidden' })).rejects.toThrow(
    'workspace_forbidden',
  );
  await expect(workspace.disable(member, created.id)).rejects.toThrow('workspace_forbidden');
  await pool.query(
    "UPDATE workspace_memberships SET role='administrator' WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, member],
  );
  expect(await workspace.update(member, created.id, { modelId: 'new-model' })).toMatchObject({
    modelId: 'new-model',
    apiKeyConfigured: true,
  });
  expect(probe.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ apiKey: 'workspace-api-secret', modelId: 'new-model' }),
    undefined,
    expect.any(Function),
  );
  await workspace.disable(member, created.id);
  expect((await workspace.viewOne(owner, created.id)).connection).toMatchObject({
    id: created.id,
    availability: 'unavailable',
  });
  await expect(workspace.test(owner, created.id)).rejects.toThrow('connection_disabled');
  expect(
    (await pool.query('SELECT actor_user_id FROM audit_events ORDER BY occurred_at')).rows.map(
      (row: { actor_user_id: string }) => row.actor_user_id,
    ),
  ).toEqual([owner, member, member]);
});

it('rejects a late management write after demotion and a late member result after removal', async () => {
  const { pool, owner, member, workspaceId, service, probe } = await fixture();
  const workspace = service.inWorkspace(workspaceId);
  const created = await workspace.save(owner, input);
  await pool.query(
    "UPDATE workspace_memberships SET role='administrator' WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, member],
  );
  let finish: (value: typeof report) => void = () => {};
  probe.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const update = workspace.update(member, created.id, { name: 'Must not persist' });
  const rejected = expect(update).rejects.toThrow('workspace_forbidden');
  await vi.waitFor(() => expect(probe.run).toHaveBeenCalledTimes(2));
  await pool.query(
    "UPDATE workspace_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, member],
  );
  finish(report);
  await rejected;
  expect((await workspace.viewOne(owner, created.id)).connection.name).toBe('Shared reasoner');
  probe.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const use = workspace.test(member, created.id);
  const useRejected = expect(use).rejects.toThrow('workspace_forbidden');
  await vi.waitFor(() => expect(probe.run).toHaveBeenCalledTimes(3));
  await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
    workspaceId,
    member,
  ]);
  finish(report);
  await useRejected;
  await expect(workspace.view(member)).rejects.toThrow('workspace_forbidden');
  await expect(workspace.viewOne(member, created.id)).rejects.toThrow('workspace_forbidden');
  await expect(workspace.test(member, created.id)).rejects.toThrow('workspace_forbidden');
});

it.each(['remove', 'disable'] as const)(
  'blocks the next provider generation when access changes between probe phases: %s',
  async (change) => {
    const { pool, owner, member, workspaceId, service } = await fixture();
    const created = await service.inWorkspace(workspaceId).save(owner, input);
    const generate = vi.fn<ModelAdapter['generate']>(async () => {
      if (change === 'remove')
        await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
          workspaceId,
          member,
        ]);
      else await service.inWorkspace(workspaceId).disable(owner, created.id);
      return {
        events: [
          { type: 'text', text: 'OK' },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: 'OK',
      };
    });
    const guarded = new ProviderConnections(
      new PostgresProviderRepository(pool),
      new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      new ModelConnectionProbe({ generate }),
    ).inWorkspace(workspaceId);
    await expect(guarded.test(member, created.id)).rejects.toThrow(
      change === 'remove' ? 'workspace_forbidden' : 'connection_disabled',
    );
    expect(generate).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['openai-chat', '/v1/chat/completions', 'authorization'],
  ['openai-responses', '/v1/responses', 'authorization'],
  ['anthropic-messages', '/v1/messages', 'x-api-key'],
] as const)(
  'uses the stored %s protocol and credentials for member probes with real transport failures',
  async (protocol, path, authHeader) => {
    const { pool, owner, member, workspaceId, service } = await fixture();
    const requests: Array<{ path: string | undefined; auth: string | string[] | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url, auth: request.headers[authHeader] });
      request.resume();
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'workspace-api-secret workspace-header-secret' } }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No mock port');
    try {
      const created = await service.inWorkspace(workspaceId).save(owner, { ...input, protocol });
      // Point the stored test fixture at the explicitly allowed local provider, preserving scope and ciphertext.
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      await pool.query('UPDATE workspace_model_connections SET metadata=$1::jsonb WHERE id=$2', [
        JSON.stringify({ ...created, baseUrl }),
        created.id,
      ]);
      const policy = new ProviderUrlPolicy({
        hosts: ['127.0.0.1'],
        schemes: ['http'],
        privateCidrs: ['127.0.0.0/8'],
      });
      const live = new ProviderConnections(
        new PostgresProviderRepository(pool),
        new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
        policy,
        new ProtocolConnectionProbe(policy),
      ).inWorkspace(workspaceId);
      const tested = await live.test(member, created.id);
      expect(tested).toMatchObject({
        text: { ok: false, code: 'provider_rate_limited' },
        action: { ok: false, code: 'provider_rate_limited' },
      });
      expect(JSON.stringify(tested)).not.toMatch(/workspace-api-secret|workspace-header-secret/u);
      expect(requests).toEqual(
        Array.from({ length: 2 }, () => ({
          path,
          auth:
            authHeader === 'authorization' ? 'Bearer workspace-api-secret' : 'workspace-api-secret',
        })),
      );
      await live.disable(owner, created.id);
      await expect(live.test(member, created.id)).rejects.toThrow('connection_disabled');
      expect(requests).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

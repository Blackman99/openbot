import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import { personalAccess } from '../../src/providers/scope.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const databaseUrl = process.env.TEST_PROVIDER_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('model connections using the deployed restricted database role', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let runtime: pg.Pool;
  beforeAll(async () => {
    await migrateDatabase(admin);
    const url = new URL(databaseUrl!);
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../../../infra/postgres/grant-runtime-privileges.mjs', import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          PGHOST: url.hostname,
          PGPORT: url.port || '5432',
          PGDATABASE: url.pathname.slice(1),
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          OPENBOT_DATABASE_PASSWORD: 'ci-provider-runtime-password',
        },
      },
    );
    url.username = 'openbot_runtime';
    url.password = 'ci-provider-runtime-password';
    runtime = new pg.Pool({ connectionString: url.toString() });
  });
  afterAll(async () => {
    await runtime?.end();
    await admin.end();
  });

  it.each(['openai-responses', 'anthropic-messages'])(
    'persists encrypted owner-only %s connections, rejects stale revisions and rolls back when audit insertion fails',
    async (protocol) => {
      const owner = randomUUID();
      await runtime.query(
        'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,$4)',
        [owner, `${owner}@example.com`, 'Owner', new Date()],
      );
      const repository = new PostgresProviderRepository(runtime);
      const service = new ProviderConnections(
        repository,
        new ProviderSecretBox(randomBytes(32).toString('base64')),
        new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
        {
          run: async () => ({
            testedAt: new Date().toISOString(),
            text: { ok: true, code: 'passed', raw: 'OK' },
            action: { ok: true, code: 'passed', raw: '{}' },
          }),
        },
      );
      const created = await service.save(owner, {
        protocol,
        ...(protocol === 'anthropic-messages' ? { anthropicVersion: '2023-06-01' } : {}),
        name: 'Personal model',
        baseUrl: 'https://models.example/v1',
        modelId: 'model',
        apiKey: 'ci-provider-secret',
        headers: { 'x-provider-token': 'ci-header-secret' },
      });
      const stored = await runtime.query('SELECT * FROM personal_model_connections WHERE id=$1', [
        created.id,
      ]);
      expect(stored.rows[0].metadata.protocol).toBe(protocol);
      if (protocol === 'anthropic-messages')
        expect(stored.rows[0].metadata.anthropicVersion).toBe('2023-06-01');
      expect(await service.get(owner, created.id)).toMatchObject({ protocol });
      expect(JSON.stringify(stored.rows)).not.toMatch(/ci-provider-secret|ci-header-secret/u);
      expect(await service.list(randomUUID())).toEqual([]);
      const stale = await repository.find(personalAccess(owner), created.id);
      expect(stale).toBeDefined();
      await service.disable(owner, created.id);
      expect(await repository.replace(stale!, 'provider.connection_tested')).toBe(false);
      expect(await service.get(owner, created.id)).toMatchObject({ enabled: false });
      await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
      await expect(service.delete(owner, created.id)).rejects.toThrow();
      expect(await service.get(owner, created.id)).toMatchObject({ id: created.id });
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
      await service.delete(owner, created.id);
      expect(await service.list(owner)).toEqual([]);
      await expect(
        runtime.query('ALTER TABLE personal_model_connections DISABLE TRIGGER ALL'),
      ).rejects.toThrow();
      await expect(runtime.query("UPDATE audit_events SET metadata='{}'::jsonb")).rejects.toThrow();
      const audits = await admin.query('SELECT metadata FROM audit_events WHERE actor_user_id=$1', [
        owner,
      ]);
      expect(audits.rows).toHaveLength(3);
      expect(JSON.stringify(audits.rows)).not.toMatch(/ci-provider-secret|ci-header-secret/u);
    },
  );
  it('enforces workspace grants, scoped encryption, transactional audit rollback and revocation ordering under the restricted role', async () => {
    const owner = randomUUID();
    const administrator = randomUUID();
    const member = randomUUID();
    const workspaceId = randomUUID();
    for (const id of [owner, administrator, member])
      await runtime.query(
        'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
        [id, `${id}@example.com`, 'Workspace user'],
      );
    await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
      workspaceId,
      'Shared models',
    ]);
    for (const [userId, role] of [
      [owner, 'owner'],
      [administrator, 'administrator'],
      [member, 'member'],
    ])
      await runtime.query(
        'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
        [workspaceId, userId, role],
      );
    const applicationName = `prov02-${randomUUID()}`;
    const scopedPool = new pg.Pool({
      connectionString: runtime.options.connectionString,
      application_name: applicationName,
    });
    const repository = new PostgresProviderRepository(scopedPool);
    const probe = {
      run: vi.fn(async () => ({
        testedAt: new Date().toISOString(),
        text: { ok: true, code: 'passed', raw: 'OK' },
        action: { ok: true, code: 'passed', raw: '{}' },
      })),
    };
    const service = new ProviderConnections(
      repository,
      new ProviderSecretBox(randomBytes(32).toString('base64')),
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      probe,
    ).inWorkspace(workspaceId);
    try {
      const created = await service.save(owner, {
        protocol: 'openai-responses',
        name: 'Shared',
        baseUrl: 'https://models.example/v1',
        modelId: 'model',
        apiKey: 'ci-workspace-secret',
        headers: { 'x-token': 'ci-workspace-header' },
      });
      await expect(service.update(member, created.id, { apiKey: 'forbidden' })).rejects.toThrow(
        'workspace_forbidden',
      );
      await service.update(administrator, created.id, { modelId: 'changed' });
      expect(probe.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: 'ci-workspace-secret', modelId: 'changed' }),
        undefined,
        expect.any(Function),
      );
      await service.test(member, created.id);
      const stale = await repository.find(
        { actorUserId: owner, scope: { kind: 'workspace', id: workspaceId } },
        created.id,
      );
      await service.disable(administrator, created.id);
      expect(await repository.replace(stale!, 'provider.connection_tested')).toBe(false);
      await expect(service.test(member, created.id)).rejects.toThrow('connection_disabled');
      expect((await service.viewOne(member, created.id)).connection.availability).toBe(
        'unavailable',
      );
      await service.update(owner, created.id, { name: 'Re-enabled' });
      await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
      try {
        await expect(service.disable(administrator, created.id)).rejects.toThrow();
        await expect(
          service.save(owner, {
            protocol: 'openai-chat',
            name: 'Must roll back',
            baseUrl: 'https://models.example/v1',
            modelId: 'model',
            apiKey: 'rollback-secret',
            headers: {},
          }),
        ).rejects.toThrow();
      } finally {
        await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
      }
      expect((await service.viewOne(member, created.id)).connection.availability).toBe('available');
      expect((await service.view(owner)).connections).toHaveLength(1);
      await expect(
        runtime.query('UPDATE workspace_model_connections SET workspace_id=$1 WHERE id=$2', [
          randomUUID(),
          created.id,
        ]),
      ).rejects.toThrow();
      await expect(
        runtime.query('DELETE FROM workspace_model_connections WHERE id=$1', [created.id]),
      ).rejects.toMatchObject({ code: '42501' });
      const before = probe.run.mock.calls.length;
      const blocker = await admin.connect();
      let blockedUse: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
        blockedUse = expect(service.test(member, created.id)).rejects.toThrow(
          'workspace_forbidden',
        );
        await vi.waitFor(async () => {
          const waiting = await admin.query(
            "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
            [applicationName],
          );
          expect(waiting.rows).toHaveLength(1);
        });
        await blocker.query(
          'DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
          [workspaceId, member],
        );
        await blocker.query('COMMIT');
        await blockedUse;
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(probe.run).toHaveBeenCalledTimes(before);
      await expect(service.view(member)).rejects.toThrow('workspace_forbidden');
      const rows = await admin.query(
        'SELECT metadata,sealed_credentials FROM workspace_model_connections WHERE workspace_id=$1',
        [workspaceId],
      );
      expect(JSON.stringify(rows.rows)).not.toMatch(
        /ci-workspace-secret|ci-workspace-header|rollback-secret/u,
      );
      const audits = await admin.query(
        "SELECT actor_user_id,metadata FROM audit_events WHERE metadata->>'workspaceId'=$1 ORDER BY occurred_at",
        [workspaceId],
      );
      expect(audits.rows).toHaveLength(5);
      expect(audits.rows.map((row) => row.actor_user_id).sort()).toEqual(
        [owner, administrator, member, administrator, owner].sort(),
      );
      expect(audits.rows.map((row) => row.metadata)).toEqual(
        Array.from({ length: 5 }, () => ({ workspaceId, connectionId: created.id })),
      );
    } finally {
      await scopedPool.end();
    }
  });
});

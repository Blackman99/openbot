import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const databaseUrl = process.env.TEST_PROVIDER_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('personal connections using the deployed restricted database role', () => {
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
      const stale = await repository.find(owner, created.id);
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
});

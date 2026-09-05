import { CapabilityApiClient } from '../../../web/src/lib/server/capability-api.js';
import { createHash } from 'node:crypto';
import { newProviderDatabase } from '../helpers/provider-database.js';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

it('protects personal connection lifecycle API, returns masks, and rejects cross-origin mutations', async () => {
  const adapter = newProviderDatabase().adapters.createPg();
  const pool = new adapter.Pool();
  await migrateDatabase(pool, { installPostgresGuards: false });
  const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
    hashPassword: async () => '$argon2id$fixture-only',
  });
  const providers = new ProviderConnections(
    new PostgresProviderRepository(pool),
    new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
    {
      run: async () => ({
        testedAt: '2030-01-02T00:00:00.000Z',
        text: { ok: true, code: 'passed', raw: 'OK' },
        action: { ok: true, code: 'passed', raw: '{}' },
      }),
    },
  );
  const app = buildApp({
    auth,
    providers,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    setupTokenDigest: createHash('sha256').update('setup-token').digest('hex'),
  });
  closers.push(
    async () => app.close(),
    async () => pool.end(),
  );
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    headers: { origin: 'http://localhost:3000', 'x-openbot-setup-token': 'setup-token' },
    payload: {
      displayName: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    },
  });
  const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const headers = { cookie, origin: 'http://localhost:3000' };
  const path = '/api/v1/model-connections';
  expect((await app.inject({ url: path })).statusCode).toBe(401);
  const input = {
    protocol: 'openai-responses',
    name: 'Model',
    baseUrl: 'https://models.example/v1',
    modelId: 'chat-model',
    apiKey: 'secret-key',
    headers: { 'x-secret': 'sensitive-header' },
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: path,
        headers: { cookie, origin: 'https://evil.example' },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  const malformed = await app.inject({
    method: 'POST',
    url: path,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: 'malformed-api-secret',
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('malformed-api-secret');
  expect(malformed.json()).toEqual({ error: { code: 'invalid_connection' } });
  expect(malformed.headers['cache-control']).toBe('private, no-store');
  const created = await app.inject({ method: 'POST', url: path, headers, payload: input });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ protocol: 'openai-responses' });
  expect(created.headers['cache-control']).toBe('private, no-store');
  expect(created.body).not.toMatch(/secret-key|sensitive-header/u);
  const id = created.json<{ id: string }>().id;
  const capabilities = await app.inject({ url: `${path}/${id}/policy`, headers });
  expect(capabilities.statusCode).toBe(200);
  expect(capabilities.json()).toMatchObject({
    basic: true,
    collaboration: true,
    revision: 0,
    flags: { visionInput: { status: 'unknown' } },
  });
  expect(capabilities.body).not.toMatch(/secret-key|sensitive-header|baseUrl|raw|apiKey/u);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const client = new CapabilityApiClient(fetch, address, 'http://localhost:3000');
  const token = cookie.split('=')[1]!;
  expect(await client.get(token, id)).toMatchObject({ ok: true, value: { basic: true } });
  expect(
    await client.override(token, id, {
      expectedRevision: 0,
      capability: 'visionInput',
      value: true,
      rationale: 'Image fixture verified',
    }),
  ).toMatchObject({ ok: true, value: { revision: 1, enhanced: { visionInput: true } } });
  expect(await client.reprobe(token, id, 1)).toMatchObject({
    ok: true,
    value: { revision: 2, flags: { visionInput: { manualBadge: true } } },
  });
  expect(
    await client.fallbacks(token, id, {
      expectedRevision: 2,
      requiredCapability: 'collaboration',
      connectionIds: [],
    }),
  ).toMatchObject({
    ok: true,
    value: { revision: 3, fallbacks: { requiredCapability: 'collaboration' } },
  });
  expect(await client.preview(token, id, 'collaboration')).toMatchObject({
    ok: true,
    value: { primaryId: id, selectedId: id, order: [id] },
  });
  expect(
    await client.fallbacks(token, id, {
      expectedRevision: 2,
      requiredCapability: 'basic',
      connectionIds: [],
    }),
  ).toEqual({ ok: false, code: 'connection_conflict' });
  const uppercaseOverride = await app.inject({
    method: 'POST',
    url: `${path}/${id.toUpperCase()}/overrides`,
    headers,
    payload: {
      expectedRevision: 3,
      capability: 'text',
      value: true,
      rationale: 'Verified the same canonical target',
    },
  });
  expect(uppercaseOverride.statusCode).toBe(200);
  expect(uppercaseOverride.json()).toMatchObject({
    id,
    revision: 4,
    flags: { text: { manualBadge: true } },
  });
  expect((await app.inject({ url: `${path}/${id}`, headers })).statusCode).toBe(200);
  expect((await app.inject({ url: path, headers })).json()).toHaveLength(1);
  expect(
    (await app.inject({ method: 'POST', url: `${path}/${id}/test`, headers })).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${path}/${id}`,
        headers,
        payload: { name: 'Changed', modelId: 'another' },
      })
    ).json(),
  ).toMatchObject({ name: 'Changed', protocol: 'openai-responses' });
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `${path}/${id}`,
        headers,
        payload: { enabled: false },
      })
    ).json(),
  ).toMatchObject({ enabled: false });
  expect((await app.inject({ method: 'DELETE', url: `${path}/${id}`, headers })).statusCode).toBe(
    204,
  );
  expect((await app.inject({ url: `${path}/${id}`, headers })).statusCode).toBe(404);
});

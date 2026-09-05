import { randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const pools: Array<{ end(): Promise<void> }> = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end();
});
const input = {
  name: 'My model',
  baseUrl: 'https://models.example/v1',
  modelId: 'chat-model',
  apiKey: 'secret-api-key',
  headers: { 'x-secret': 'secret-header-value' },
};
const report = {
  testedAt: '2030-01-02T00:00:00.000Z',
  text: { ok: true, code: 'passed', raw: 'OK' },
  action: { ok: false, code: 'provider_action_unsupported', raw: '{}' },
};

async function fixture() {
  const adapter = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);
  await migrateDatabase(pool, { installPostgresGuards: false });
  const owner = randomUUID();
  await pool.query(
    'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$3,$4)',
    [owner, 'ada@example.com', 'Ada', new Date()],
  );
  const probe = { run: vi.fn(async () => report) };
  const service = new ProviderConnections(
    new PostgresProviderRepository(pool),
    new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
    probe,
  );
  return { pool, owner, probe, service };
}

it('tests before saving a personal Basic connection and persists only authenticated ciphertext and safe evidence', async () => {
  const { pool, owner, probe, service } = await fixture();
  const connection = await service.save(owner, input);
  expect(probe.run).toHaveBeenCalledOnce();
  expect(connection).toMatchObject({
    name: 'My model',
    enabled: true,
    apiKeyConfigured: true,
    headerNames: ['x-secret'],
    lastProbe: report,
  });
  expect(JSON.stringify(connection)).not.toMatch(/secret-api-key|secret-header-value/u);
  expect(await service.get(owner, connection.id)).toEqual(connection);
  expect(await service.list(owner)).toEqual([connection]);
  const stored = await pool.query('SELECT * FROM personal_model_connections');
  expect(stored.rows).toHaveLength(1);
  expect(JSON.stringify(stored.rows)).not.toMatch(/secret-api-key|secret-header-value/u);
  const audits = await pool.query('SELECT event_type,metadata FROM audit_events');
  expect(audits.rows).toEqual([
    { event_type: 'provider.connection_created', metadata: { connectionId: connection.id } },
  ]);
});

it('enforces ownership before reads, updates or invocation and manages a connection without echoing retained credentials', async () => {
  const { pool, owner, probe, service } = await fixture();
  const connection = await service.save(owner, input);
  const other = randomUUID();
  for (const attempt of [
    () => service.get(other, connection.id),
    () => service.update(other, connection.id, input),
    () => service.test(other, connection.id),
    () => service.disable(other, connection.id),
    () => service.delete(other, connection.id),
  ]) {
    await expect(attempt()).rejects.toThrow('connection_not_found');
  }
  expect(await service.list(other)).toEqual([]);
  expect(probe.run).toHaveBeenCalledTimes(1);
  const updated = await service.update(owner, connection.id, {
    name: 'Renamed',
    baseUrl: input.baseUrl,
    modelId: 'new-model',
  });
  expect(updated).toMatchObject({ name: 'Renamed', modelId: 'new-model', apiKeyConfigured: true });
  expect(probe.run).toHaveBeenLastCalledWith(
    expect.objectContaining({
      apiKey: 'secret-api-key',
      headers: { 'x-secret': 'secret-header-value' },
    }),
    undefined,
  );
  expect(await service.test(owner, connection.id)).toEqual(report);
  expect(await service.disable(owner, connection.id)).toMatchObject({ enabled: false });
  await expect(service.test(owner, connection.id)).rejects.toThrow('connection_disabled');
  await service.delete(owner, connection.id);
  expect(await service.list(owner)).toEqual([]);
  const audits = await pool.query('SELECT event_type,metadata FROM audit_events');
  expect(audits.rows.map((row: { event_type: string }) => row.event_type)).toEqual([
    'provider.connection_created',
    'provider.connection_updated',
    'provider.connection_tested',
    'provider.connection_disabled',
    'provider.connection_deleted',
  ]);
  expect(JSON.stringify(audits.rows)).not.toMatch(/secret-api-key|secret-header-value/u);
});

it('does not overwrite a concurrent disable or credential rotation when a slow probe finishes', async () => {
  const { owner, probe, service } = await fixture();
  const connection = await service.save(owner, input);
  let finish: (value: typeof report) => void = () => {};
  probe.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = service.test(owner, connection.id);
  const rejected = expect(pending).rejects.toThrow('connection_conflict');
  await vi.waitFor(() => expect(probe.run).toHaveBeenCalledTimes(2));
  await service.disable(owner, connection.id);
  finish(report);
  await rejected;
  expect(await service.get(owner, connection.id)).toMatchObject({ enabled: false });

  await service.update(owner, connection.id, {});
  probe.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const rotating = service.test(owner, connection.id);
  const rotationRejected = expect(rotating).rejects.toThrow('connection_conflict');
  await vi.waitFor(() => expect(probe.run).toHaveBeenCalledTimes(4));
  await service.update(owner, connection.id, { apiKey: 'new-secret-key' });
  finish(report);
  await rotationRejected;
  await service.test(owner, connection.id);
  expect(probe.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ apiKey: 'new-secret-key' }),
    undefined,
  );
});

it('rejects unsafe headers and cancelled or forbidden probes without persisting connections', async () => {
  const { owner, probe, service } = await fixture();
  for (const headers of [
    { host: 'internal' },
    { 'x-key': 'value\r\nHost: internal' },
    { Authorization: 'Bearer secret', authorization: 'another' },
    { 'x-key': 42 },
  ]) {
    await expect(service.save(owner, { ...input, headers })).rejects.toThrow('invalid_connection');
  }
  expect(probe.run).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(service.save(owner, input, controller.signal)).rejects.toThrow('provider_cancelled');
  probe.run.mockResolvedValueOnce({
    ...report,
    text: { ok: false, code: 'provider_url_not_allowed', raw: '' },
  });
  await expect(service.save(owner, input)).rejects.toThrow('provider_url_not_allowed');
  expect(await service.list(owner)).toEqual([]);
});

it('persists explicit Responses protocol through updates and defaults legacy Chat records', async () => {
  const { owner, probe, service, pool } = await fixture();
  const connection = await service.save(owner, { ...input, protocol: 'openai-responses' });
  expect(connection).toMatchObject({ protocol: 'openai-responses' });
  expect(probe.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ protocol: 'openai-responses' }),
    undefined,
  );
  expect(await service.update(owner, connection.id, { name: 'Renamed Responses' })).toMatchObject({
    protocol: 'openai-responses',
  });
  const stored = await pool.query('SELECT metadata FROM personal_model_connections WHERE id=$1', [
    connection.id,
  ]);
  expect(stored.rows[0].metadata.protocol).toBe('openai-responses');
  const legacy = { ...stored.rows[0].metadata };
  delete legacy.protocol;
  await pool.query('UPDATE personal_model_connections SET metadata=$1::jsonb WHERE id=$2', [
    JSON.stringify(legacy),
    connection.id,
  ]);
  expect(await service.get(owner, connection.id)).toMatchObject({ protocol: 'openai-chat' });
  await expect(service.save(owner, { ...input, protocol: 'guess' })).rejects.toThrow(
    'invalid_connection',
  );
});

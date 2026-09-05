import { admitUsableModel } from '../../src/providers/postgres-model-admission.js';
import type { ConnectionProbe } from '../../src/providers/model-probe.js';
import { personalAccess } from '../../src/providers/scope.js';
import { randomUUID } from 'node:crypto';
import { newProviderDatabase } from '../helpers/provider-database.js';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const input = {
  protocol: 'openai-chat',
  name: 'Model',
  baseUrl: 'https://models.example/v1',
  modelId: 'basic-model',
  apiKey: 'secret-key',
  headers: { 'x-token': 'secret-header' },
};
const report = {
  testedAt: '2030-01-02T00:00:00.000Z',
  text: { ok: true, code: 'passed', raw: 'secret-key' },
  action: { ok: false, code: 'provider_action_unsupported', raw: 'secret-header' },
};
async function fixture() {
  const pool = new (newProviderDatabase().adapters.createPg().Pool)();
  closers.push(() => pool.end());
  await migrateDatabase(pool, { installPostgresGuards: false });
  const owner = randomUUID();
  await pool.query(
    'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
    [owner, `${owner}@example.com`, 'Owner'],
  );
  const probe = { run: vi.fn<ConnectionProbe['run']>(async () => structuredClone(report)) };
  const service = new ProviderConnections(
    new PostgresProviderRepository(pool),
    new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
    probe,
  );
  return { pool, owner, probe, service };
}

it('persists attributable text/streaming proof without upgrading a Basic model or guessing Enhanced capabilities', async () => {
  const { pool, owner, service } = await fixture();
  const created = await service.save(owner, input);
  const details = await service.capabilities(owner, created.id);
  expect(details).toMatchObject({
    revision: 0,
    canManage: true,
    generation: 1,
    basic: true,
    collaboration: false,
    enhanced: { visionInput: false },
    lastProbedAt: report.testedAt,
  });
  expect(details.flags.text).toMatchObject({
    status: 'supported',
    source: 'probe',
    actorUserId: owner,
    evidence: 'passed',
    manualBadge: false,
  });
  expect(details.flags.streaming).toMatchObject({ status: 'supported', source: 'probe' });
  expect(details.flags.toolCalling).toMatchObject({
    status: 'unsupported',
    source: 'probe',
    evidence: 'provider_action_unsupported',
  });
  expect(details.flags.structuredOutput).toMatchObject({ status: 'unknown', source: 'unknown' });
  expect(details.flags.visionInput).toMatchObject({ status: 'unknown', source: 'unknown' });
  expect(JSON.stringify(details)).not.toMatch(
    /secret-key|secret-header|raw|baseUrl|apiKey|headerNames/u,
  );
  const audit = await pool.query('SELECT actor_user_id,metadata FROM audit_events');
  expect(audit.rows[0]).toMatchObject({
    actor_user_id: owner,
    metadata: {
      connectionId: created.id,
      policyAfter: {
        generation: 1,
        probes: { text: { actorUserId: owner, testedAt: report.testedAt } },
      },
    },
  });
});

it('advances target generation on model edits, preserves immutable proof attribution, and keeps name edits and re-probes on the same target', async () => {
  const { pool, owner, probe, service } = await fixture();
  const created = await service.save(owner, input);
  probe.run.mockResolvedValueOnce({ ...report, action: { ok: true, code: 'passed', raw: '{}' } });
  await service.update(owner, created.id, { modelId: 'collaboration-model' });
  expect(await service.capabilities(owner, created.id)).toMatchObject({
    revision: 1,
    generation: 2,
    collaboration: true,
  });
  await service.test(owner, created.id);
  expect(await service.capabilities(owner, created.id)).toMatchObject({
    revision: 2,
    generation: 2,
    collaboration: false,
    flags: { toolCalling: { actorUserId: owner, evidence: 'provider_action_unsupported' } },
  });
  await service.update(owner, created.id, { name: 'Renamed only' });
  expect(await service.capabilities(owner, created.id)).toMatchObject({
    revision: 3,
    generation: 2,
  });
  const audits = await pool.query(
    'SELECT actor_user_id,metadata FROM audit_events ORDER BY occurred_at',
  );
  expect(audits.rows[0]).toMatchObject({
    actor_user_id: owner,
    metadata: {
      policyAfter: { generation: 1, probes: { toolCalling: { status: 'unsupported' } } },
    },
  });
  expect(audits.rows[1]).toMatchObject({
    actor_user_id: owner,
    metadata: {
      revisionBefore: 0,
      revisionAfter: 1,
      policyBefore: { generation: 1 },
      policyAfter: {
        generation: 2,
        probes: { toolCalling: { status: 'supported', actorUserId: owner } },
      },
    },
  });
  expect(JSON.stringify(audits.rows)).not.toMatch(
    /secret-key|secret-header|raw|headerNames|baseUrl/u,
  );
});

it('keeps justified manual overrides attributable across probes and inactive after a target change', async () => {
  const { pool, owner, service } = await fixture();
  const created = await service.save(owner, input);
  await expect(
    service.override(owner, created.id, {
      expectedRevision: 0,
      capability: 'visionInput',
      value: true,
      rationale: '  ',
    }),
  ).rejects.toThrow('invalid_capability_policy');
  const overridden = await service.override(owner, created.id, {
    expectedRevision: 0,
    capability: 'visionInput',
    value: true,
    rationale: 'Verified image input with secret-key and secret-header',
  });
  expect(overridden).toMatchObject({
    revision: 1,
    generation: 1,
    enhanced: { visionInput: true },
    flags: {
      visionInput: {
        status: 'supported',
        source: 'manual',
        actorUserId: owner,
        manualBadge: true,
        override: { active: true, generation: 1 },
      },
    },
  });
  expect(JSON.stringify(overridden)).not.toMatch(/secret-key|secret-header/u);
  await service.test(owner, created.id);
  expect(await service.capabilities(owner, created.id)).toMatchObject({
    revision: 2,
    generation: 1,
    flags: { visionInput: { source: 'manual', manualBadge: true, override: { active: true } } },
  });
  await expect(
    service.override(owner, created.id, {
      expectedRevision: 1,
      capability: 'toolCalling',
      value: true,
      rationale: 'Stale update',
    }),
  ).rejects.toThrow('connection_conflict');
  await service.update(owner, created.id, { apiKey: 'rotated-key' });
  expect(await service.capabilities(owner, created.id)).toMatchObject({
    revision: 3,
    generation: 2,
    enhanced: { visionInput: false },
    flags: {
      visionInput: {
        status: 'unknown',
        source: 'unknown',
        manualBadge: true,
        override: { active: false, actorUserId: owner, generation: 1 },
      },
    },
  });
  const audit = await pool.query(
    "SELECT actor_user_id,metadata FROM audit_events WHERE event_type='provider.capability_overridden'",
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    actor_user_id: owner,
    metadata: {
      revisionBefore: 0,
      revisionAfter: 1,
      policyAfter: {
        overrides: { visionInput: { actorUserId: owner, generation: 1, value: true } },
      },
    },
  });
  expect(JSON.stringify(audit.rows)).not.toMatch(/secret-key|secret-header|rotated-key|raw/u);
});

it('orders same-scope fallback graphs deterministically and never resolves Basic-only models for Collaboration work', async () => {
  const { owner, service } = await fixture();
  const a = await service.save(owner, { ...input, name: 'Primary' });
  const b = await service.save(owner, { ...input, name: 'Second' });
  const c = await service.save(owner, { ...input, name: 'Third' });
  await service.setFallbacks(owner, a.id, {
    expectedRevision: 0,
    requiredCapability: 'basic',
    connectionIds: [b.id, c.id],
  });
  await service.setFallbacks(owner, b.id, {
    expectedRevision: 0,
    requiredCapability: 'basic',
    connectionIds: [c.id],
  });
  const preview = await service.preview(owner, a.id, 'basic');
  expect(preview).toMatchObject({ primaryId: a.id, selectedId: a.id, order: [a.id, b.id, c.id] });
  expect(preview.candidates.map((candidate) => candidate.id)).toEqual([a.id, b.id, c.id]);
  const collaboration = await service.preview(owner, a.id, 'collaboration');
  expect(collaboration).toMatchObject({ selectedId: null, order: [] });
  expect(collaboration.candidates.every((candidate) => !candidate.eligible)).toBe(true);
  await expect(
    service.setFallbacks(owner, c.id, {
      expectedRevision: 0,
      requiredCapability: 'basic',
      connectionIds: [a.id],
    }),
  ).rejects.toThrow('fallback_cycle');
  await expect(
    service.setFallbacks(owner, c.id, {
      expectedRevision: 0,
      requiredCapability: 'basic',
      connectionIds: [a.id, a.id.toUpperCase()],
    }),
  ).rejects.toThrow('duplicate_fallback');
  await expect(
    service.setFallbacks(owner, c.id, {
      expectedRevision: 0,
      requiredCapability: 'collaboration',
      connectionIds: [b.id],
    }),
  ).rejects.toThrow('fallback_capability_required');
  await service.disable(owner, b.id);
  expect(await service.preview(owner, a.id, 'basic')).toMatchObject({
    order: [a.id, c.id],
    candidates: [
      { id: a.id, eligible: true },
      { id: b.id, eligible: false, reason: 'disabled' },
      { id: c.id, eligible: true },
    ],
  });
  await service.delete(owner, c.id);
  expect(await service.preview(owner, a.id, 'basic')).toMatchObject({
    order: [a.id],
    candidates: [
      { id: a.id },
      { id: b.id },
      { id: c.id, eligible: false, reason: 'not_accessible' },
    ],
  });
});

it('admits a current Basic model within the caller transaction without exposing credentials or pinning credential revisions', async () => {
  const { pool, owner, service } = await fixture();
  const created = await service.save(owner, input);
  const transaction = await pool.connect();
  const expected = { connectionId: created.id, expectedModelId: input.modelId };
  try {
    await transaction.query('BEGIN');
    const binding = await admitUsableModel(transaction, personalAccess(owner), expected);
    expect(binding).toEqual({
      scope: { kind: 'personal', id: owner },
      connectionId: created.id,
      modelId: input.modelId,
      chatOnly: true,
    });
    await transaction.query('COMMIT');
    await service.update(owner, created.id, { apiKey: 'rotated' });
    await transaction.query('BEGIN');
    expect(await admitUsableModel(transaction, personalAccess(owner), expected)).toEqual(binding);
    await transaction.query('COMMIT');
    await service.update(owner, created.id, { modelId: 'changed-model' });
    await transaction.query('BEGIN');
    await expect(admitUsableModel(transaction, personalAccess(owner), expected)).rejects.toThrow(
      'model_binding_changed',
    );
    await transaction.query('ROLLBACK');
    await service.disable(owner, created.id);
    await transaction.query('BEGIN');
    await expect(
      admitUsableModel(transaction, personalAccess(owner), {
        ...expected,
        expectedModelId: 'changed-model',
      }),
    ).rejects.toThrow('connection_disabled');
    await transaction.query('ROLLBACK');
  } finally {
    await transaction.query('ROLLBACK');
    transaction.release();
  }
});

it('rechecks personal enabled state before the next provider probe dispatch', async () => {
  const { owner, service, probe } = await fixture();
  const created = await service.save(owner, input);
  let dispatched = false;
  probe.run.mockImplementationOnce(async (_input, _signal, admission) => {
    await service.disable(owner, created.id);
    await admission?.();
    dispatched = true;
    return report;
  });
  await expect(service.reprobe(owner, created.id, { expectedRevision: 0 })).rejects.toThrow(
    'connection_disabled',
  );
  expect(dispatched).toBe(false);
  expect(await service.capabilities(owner, created.id)).toMatchObject({
    enabled: false,
    revision: 1,
  });
});

it('leaves legacy proof unattributed until a fresh probe and requires streaming before manual structured output can grant Collaboration', async () => {
  const { pool, owner, service } = await fixture();
  const created = await service.save(owner, input);
  await pool.query("UPDATE personal_model_connections SET policy='{}'::jsonb WHERE id=$1", [
    created.id,
  ]);
  expect(await service.capabilities(owner, created.id)).toMatchObject({
    generation: 0,
    basic: false,
    collaboration: false,
    lastProbedAt: null,
    flags: { text: { source: 'unknown', actorUserId: null, observedAt: null } },
  });
  expect(await service.preview(owner, created.id, 'basic')).toMatchObject({
    order: [],
    candidates: [{ reason: 'capability_unknown' }],
  });
  expect(await service.reprobe(owner, created.id, { expectedRevision: 0 })).toMatchObject({
    basic: true,
    flags: { text: { source: 'probe', actorUserId: owner } },
  });
  expect(
    await service.override(owner, created.id, {
      expectedRevision: 1,
      capability: 'structuredOutput',
      value: true,
      rationale: 'Verified schema-conforming action output',
    }),
  ).toMatchObject({ basic: true, collaboration: true });
  expect(
    await service.override(owner, created.id, {
      expectedRevision: 2,
      capability: 'streaming',
      value: false,
      rationale: 'Streaming disabled by gateway configuration',
    }),
  ).toMatchObject({ basic: false, collaboration: false });
  expect(await service.preview(owner, created.id, 'collaboration')).toMatchObject({
    selectedId: null,
    order: [],
  });
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await expect(
      admitUsableModel(connection, personalAccess(owner), {
        connectionId: created.id,
        expectedModelId: input.modelId,
      }),
    ).rejects.toThrow('model_capability_required');
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
  }
});

it('invalidates active target evidence for endpoint, protocol, version and header edits while preserving manual history', async () => {
  const { owner, service } = await fixture();
  const created = await service.save(owner, input);
  for (const [index, change] of [
    { baseUrl: 'https://models.example/v2' },
    { protocol: 'anthropic-messages' },
    { anthropicVersion: '2023-01-01' },
    { headers: { 'x-token': 'rotated-header' } },
  ].entries()) {
    const current = await service.capabilities(owner, created.id);
    await service.override(owner, created.id, {
      expectedRevision: current.revision,
      capability: 'visionInput',
      value: true,
      rationale: 'Verified this target manually',
    });
    await service.update(owner, created.id, change);
    expect(await service.capabilities(owner, created.id)).toMatchObject({
      generation: index + 2,
      flags: {
        visionInput: {
          status: 'unknown',
          manualBadge: true,
          override: { active: false, generation: index + 1 },
        },
      },
    });
  }
});

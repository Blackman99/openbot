import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { BotAclService } from '../../src/bots/acl-service.js';
import { PostgresBotAclRepository } from '../../src/bots/postgres-bot-acl-repository.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotService } from '../../src/bots/service.js';
import {
  ConversationTransaction,
  PostgresConversationRepository,
} from '../../src/conversations/postgres-repository.js';
import { ConversationService } from '../../src/conversations/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresGroupBotRepository } from '../../src/group-bots/postgres-repository.js';
import { GroupBotService } from '../../src/group-bots/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { UNTRUSTED_KNOWLEDGE_WARNING } from '../../src/knowledge/citation.js';
import { MemoryService } from '../../src/memories/service.js';
import {
  BOT_PRIVATE_VISIBILITY_SUMMARY,
  MemoryAccessError,
  MemoryConflictError,
} from '../../src/memories/types.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';
import { ExtractionWorker } from '../../src/memories/extraction-worker.js';
import { TaskQueue, type TaskClaim } from '../../src/tasks/queue.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';

// Dedicated CI database: the provisioner rotates a fixed runtime role. Do not
// share this service with another native job. SQL/locks/guards are all native;
// only provider capability/transport is deterministic fixture data.
const databaseUrl = process.env.TEST_MEMORY_DATABASE_URL;
describe.skipIf(!databaseUrl)('group memories with deployed PostgreSQL privileges', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let runtime: pg.Pool;
  const cleanup: Array<() => Promise<unknown>> = [];
  const claims: TaskClaim[] = [];
  const secrets = new ProviderSecretBox(randomBytes(32).toString('base64'));
  beforeAll(async () => {
    await migrateDatabase(admin);
    const versions = (
      await admin.query('SELECT version FROM openbot_schema_migrations ORDER BY version')
    ).rows;
    const attachmentIndex = versions.findIndex(
      (row) => row.version === '0018_conversation_attachments',
    );
    expect(versions.slice(attachmentIndex, attachmentIndex + 3)).toEqual([
      { version: '0018_conversation_attachments' },
      { version: '0019_conversation_delivery' },
      { version: '0020_group_source_memories' },
    ]);
    expect(versions.at(-1)).toEqual({ version: '0031_memory_revisions_and_revocations' });
    const url = new URL(databaseUrl!),
      password = `ci-memory-${randomBytes(24).toString('hex')}`;
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
          OPENBOT_DATABASE_PASSWORD: password,
        },
      },
    );
    url.username = 'openbot_runtime';
    url.password = password;
    runtime = new pg.Pool({ connectionString: url.toString(), statement_timeout: 15000 });
  });
  afterEach(async () => {
    // Retained data is never truncated or rewritten for fixture cleanup.
    for (const claim of claims.splice(0))
      await new TaskQueue(runtime).finish(claim, { error: 'worker_stopped', usage: null });
    while (
      runtime &&
      (await new TaskWorker(runtime, {
        secrets,
        createAdapter: () => ({
          generate: async () => ({
            events: [
              { type: 'text', text: 'Fixture cleanup.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          }),
        }),
      }).runOnce())
    ) {
      /* drain queued fixture work through its real transitions */
    }
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await runtime?.end();
    await admin.end();
  });
  async function fixture() {
    const workspaceId = randomUUID(),
      ownerId = randomUUID(),
      memberId = randomUUID(),
      grantorId = randomUUID(),
      outsiderId = randomUUID();
    for (const id of [ownerId, memberId, grantorId, outsiderId])
      await runtime.query(
        'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
        [id, `${id}@example.com`, 'Memory member'],
      );
    await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
      workspaceId,
      'Native memory workspace',
    ]);
    for (const id of [ownerId, memberId, grantorId, outsiderId])
      await runtime.query(
        'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
        [workspaceId, id, id === ownerId ? 'owner' : 'member'],
      );
    const groups = new GroupService(new PostgresGroupRepository(runtime));
    const group = await groups.create(ownerId, workspaceId, { name: 'Native source group' });
    await groups.addMember(ownerId, workspaceId, group.id, { userId: memberId, role: 'member' });
    await groups.addMember(ownerId, workspaceId, group.id, { userId: grantorId, role: 'admin' });
    const conversations = new ConversationService(new PostgresConversationRepository(runtime));
    const conversation = await conversations.open(ownerId, workspaceId, {
      subject: { kind: 'group', id: group.id },
    });
    const source = await conversations.append(ownerId, workspaceId, conversation.id, {
      body: 'Native cobalt evidence.',
      idempotencyKey: 'source',
    });
    const access = { actorUserId: memberId, workspaceId, groupId: group.id };
    const command = {
      messageId: source.messageId,
      expectedSourceEventId: source.eventId,
      idempotencyKey: 'save',
      confidence: 0.5,
    };
    const memories = new MemoryService(runtime);
    const app = buildApp({
      auth: new LocalAuthService(new PostgresAuthRepository(runtime)),
      memories,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    async function headers(userId = memberId) {
      const token = randomBytes(32).toString('base64url'),
        now = new Date();
      await new PostgresAuthRepository(runtime).createSession({
        userId,
        tokenDigest: createHash('sha256').update(token).digest('hex'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3600000),
        auditId: randomUUID(),
      });
      return { cookie: `openbot_session=${token}`, origin: 'http://localhost:3000' };
    }
    return {
      workspaceId,
      ownerId,
      memberId,
      grantorId,
      outsiderId,
      groups,
      group,
      conversations,
      conversation,
      source,
      access,
      command,
      memories,
      app,
      headers,
      path: `/api/v1/workspaces/${workspaceId}/groups/${group.id}/memories`,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function execution(
    f: Fixture,
    history: 'all' | 'future-only' = 'all',
    body = 'Use the saved evidence.',
  ) {
    const providers = new ProviderConnections(
      new PostgresProviderRepository(runtime),
      secrets,
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      {
        run: async () => ({
          testedAt: new Date().toISOString(),
          text: { ok: true, code: 'passed', raw: 'OK' },
          action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
        }),
      },
    );
    const model = await providers.inWorkspace(f.workspaceId).save(f.ownerId, {
      protocol: 'openai-chat',
      name: 'Memory model',
      baseUrl: 'https://models.example/v1',
      modelId: 'memory-model',
      apiKey: 'native-memory-fixture',
      headers: {},
    });
    const bot = await new BotService(new PostgresBotRepository(runtime)).create(
      f.ownerId,
      f.workspaceId,
      {
        name: 'Memory Bot',
        roleDescription: 'Researcher',
        instructions: 'Use current saved evidence.',
        modelBinding: {
          scope: { kind: 'workspace', id: f.workspaceId },
          connectionId: model.id,
          modelId: model.modelId,
        },
      },
    );
    const acl = new BotAclService(new PostgresBotAclRepository(runtime));
    await acl.grant(f.ownerId, f.workspaceId, bot.id, { userId: f.grantorId, role: 'user' });
    const grants = new GroupBotService(new PostgresGroupBotRepository(runtime));
    const grant = await grants.invite(f.grantorId, f.workspaceId, f.group.id, {
      botId: bot.id,
      idempotencyKey: 'invite',
      history: { mode: history },
    });
    const tasks = new TaskService(runtime);
    const task = await tasks.submit(f.memberId, f.workspaceId, f.conversation.id, {
      body,
      idempotencyKey: 'run',
      groupGrantId: grant.id,
    });
    return { bot, acl, grants, grant, tasks, task, runId: task.runs[0]!.id };
  }
  async function provisionBots(f: Fixture) {
    const providers = new ProviderConnections(
      new PostgresProviderRepository(runtime),
      secrets,
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      {
        run: async () => ({
          testedAt: new Date().toISOString(),
          text: { ok: true, code: 'passed', raw: 'OK' },
          action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
        }),
      },
    );
    const model = await providers.inWorkspace(f.workspaceId).save(f.ownerId, {
      protocol: 'openai-chat',
      name: 'Promotion model',
      baseUrl: 'https://models.example/v1',
      modelId: 'promotion-model',
      apiKey: 'native-promotion-fixture',
      headers: {},
    });
    const binding = {
      scope: { kind: 'workspace' as const, id: f.workspaceId },
      connectionId: model.id,
      modelId: model.modelId,
    };
    const bots = new BotService(new PostgresBotRepository(runtime));
    const dest = await bots.create(f.ownerId, f.workspaceId, {
      name: 'Private destination',
      roleDescription: 'Researcher',
      instructions: 'Use promoted evidence.',
      modelBinding: binding,
    });
    const other = await bots.create(f.ownerId, f.workspaceId, {
      name: 'Other isolated',
      roleDescription: 'Researcher',
      instructions: 'Stay isolated.',
      modelBinding: binding,
    });
    return {
      dest,
      other,
      grants: new GroupBotService(new PostgresGroupBotRepository(runtime)),
      ownerAccess: { actorUserId: f.ownerId, workspaceId: f.workspaceId, groupId: f.group.id },
    };
  }
  async function rawPrivateInsert(
    f: Fixture,
    memoryId: string,
    botId: string,
    approverUserId: string,
    sourceEventId?: string,
  ) {
    const version = (
      await admin.query<{ id: string; source_event_id: string }>(
        'SELECT id,source_event_id FROM memory_versions WHERE memory_id=$1',
        [memoryId],
      )
    ).rows[0]!;
    await runtime.query(
      'INSERT INTO bot_private_memories(id,workspace_id,bot_id,source_group_id,source_memory_id,source_memory_version_id,source_event_id,approver_user_id,approved_at,version,version_id,idempotency_key,command_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),1,$9,$10,$11)',
      [
        randomUUID(),
        f.workspaceId,
        botId,
        f.group.id,
        memoryId,
        version.id,
        sourceEventId ?? version.source_event_id,
        approverUserId,
        randomUUID(),
        randomUUID(),
        '0'.repeat(64),
      ],
    );
  }
  async function counts(f: Fixture) {
    return (
      await admin.query(
        `SELECT (SELECT COUNT(*)::int FROM group_memories WHERE group_id=$1) AS memories,(SELECT COUNT(*)::int FROM memory_versions v JOIN group_memories m ON m.id=v.memory_id WHERE m.group_id=$1) AS versions,(SELECT COUNT(*)::int FROM audit_events WHERE event_type='memory.created' AND metadata->>'groupId'=$1::text) AS audits`,
        [f.group.id],
      )
    ).rows[0];
  }
  async function rawVersion(
    f: Fixture,
    sourceEventId = f.source.eventId,
    creationEventId = f.source.eventId,
  ) {
    const connection = await runtime.connect(),
      id = randomUUID();
    try {
      await connection.query('BEGIN');
      await connection.query(
        'INSERT INTO group_memories(id,workspace_id,group_id,conversation_id,creator_user_id,created_at,idempotency_key,command_hash) VALUES($1,$2,$3,$4,$5,NOW(),$6,$7)',
        [id, f.workspaceId, f.group.id, f.conversation.id, f.memberId, id, '0'.repeat(64)],
      );
      await connection.query(
        'INSERT INTO memory_versions(id,memory_id,version,source_message_id,source_event_id,source_creation_event_id,source_creation_sequence,confidence) VALUES($1,$2,1,$3,$4,$5,$6,0.5)',
        [randomUUID(), id, f.source.messageId, sourceEventId, creationEventId, f.source.sequence],
      );
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
  }
  async function duringWorkspaceWait<T>(
    f: Fixture,
    action: (pool: pg.Pool) => Promise<T>,
    change: (connection: pg.PoolClient) => Promise<unknown>,
  ) {
    const holder = await runtime.connect(),
      name = `memory-${randomUUID()}`,
      observed = new pg.Pool({
        connectionString: runtime.options.connectionString,
        application_name: name,
        max: 1,
        statement_timeout: 15000,
      });
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = Promise.allSettled([action(observed)]);
      await vi.waitFor(
        async () => {
          expect(
            (
              await admin.query(
                `WITH RECURSIVE chain(pid) AS (SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' UNION SELECT unnest(pg_blocking_pids(chain.pid)) FROM chain) SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND EXISTS (SELECT 1 FROM chain WHERE pid=$2)`,
                [name, pid],
              )
            ).rows,
          ).toHaveLength(1);
        },
        { timeout: 5000, interval: 20 },
      );
      await change(holder);
      await holder.query('COMMIT');
      return (await pending)[0]!;
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
      await observed.end();
    }
  }
  it('serializes concurrent same-key saves and reconstructs one immutable server-provenance version after restart', async () => {
    const f = await fixture();
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => f.memories.create(f.access, f.command)),
    );
    expect(receipts.filter((r) => !r.replayed)).toHaveLength(1);
    expect(receipts.every((r) => r.memory.id === receipts[0]!.memory.id)).toBe(true);
    expect(await counts(f)).toEqual({ memories: 1, versions: 1, audits: 1 });
    expect(await new MemoryService(runtime).get(f.access, receipts[0]!.memory.id)).toEqual(
      receipts[0]!.memory,
    );
    expect(receipts[0]!.memory).toMatchObject({
      version: 1,
      confidence: 0.5,
      confidenceSource: 'human',
      creator: { id: f.memberId },
      source: {
        eventId: f.source.eventId,
        creationEventId: f.source.eventId,
        creationSequence: f.source.sequence,
      },
    });
    expect(
      JSON.stringify(
        (
          await admin.query('SELECT * FROM memory_versions WHERE memory_id=$1', [
            receipts[0]!.memory.id,
          ])
        ).rows,
      ),
    ).not.toContain('cobalt');
  });
  it('commits content-free REST denial audits and rolls back creation/version/audit together when auditing fails', async () => {
    const f = await fixture(),
      outsider = await f.headers(f.outsiderId),
      member = await f.headers();
    const denied = await f.app.inject({
      method: 'POST',
      url: `${f.path}/search`,
      headers: outsider,
      payload: { query: 'private-query-cobalt' },
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (
        await admin.query(
          "SELECT metadata FROM audit_events WHERE event_type='memory.access_denied' AND actor_user_id=$1",
          [f.outsiderId],
        )
      ).rows,
    ).toEqual([
      { metadata: { operation: 'search', workspaceId: f.workspaceId, groupId: f.group.id } },
    ]);
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      expect(
        (await f.app.inject({ method: 'POST', url: f.path, headers: member, payload: f.command }))
          .statusCode,
      ).toBe(503);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${f.path}/search`,
            headers: outsider,
            payload: { query: 'never-log' },
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(await counts(f)).toEqual({ memories: 0, versions: 0, audits: 0 });
    expect(
      (await f.app.inject({ method: 'POST', url: f.path, headers: member, payload: f.command }))
        .statusCode,
    ).toBe(201);
  });
  it('limits runtime privileges and rejects scope or source provenance forgery and retained-row mutation', async () => {
    const f = await fixture(),
      saved = (await f.memories.create(f.access, f.command)).memory,
      other = await fixture();
    for (const table of [
      'group_memories',
      'memory_versions',
      'run_memory_references',
      'memory_promotion_intents',
      'bot_private_memories',
      'memory_promotion_confirmations',
      'run_private_memory_references',
      'run_source_manifests',
      'run_source_manifest_items',
      'memory_candidates',
      'memory_candidate_revisions',
      'memory_candidate_sources',
      'memory_extraction_jobs',
      'approved_memory_facts',
      'memory_candidate_decisions',
      'memory_candidate_review_intents',
      'memory_candidate_review_confirmations',
      'run_approved_fact_references',
      'knowledge_documents',
      'knowledge_chunks',
      'run_knowledge_references',
      'memory_revisions',
      'memory_revocation_events',
    ]) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ])
        expect(
          (
            await admin.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [
              'openbot_runtime',
              table,
              privilege,
            ])
          ).rows[0].allowed,
        ).toBe(['SELECT', 'INSERT'].includes(privilege));
      for (const statement of [`DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`])
        await expect(admin.query(statement)).rejects.toMatchObject({ code: '55000' });
    }
    expect(
      (
        await admin.query(
          "SELECT column_name,has_column_privilege('openbot_runtime','memory_extraction_jobs',column_name,'UPDATE') AS allowed FROM information_schema.columns WHERE table_schema='public' AND table_name='memory_extraction_jobs' ORDER BY column_name",
        )
      ).rows,
    ).toEqual([
      { column_name: 'attempt_count', allowed: true },
      { column_name: 'available_at', allowed: true },
      { column_name: 'claim_token', allowed: true },
      { column_name: 'created_at', allowed: false },
      { column_name: 'extractor_version', allowed: false },
      { column_name: 'last_error_code', allowed: true },
      { column_name: 'lease_expires_at', allowed: true },
      { column_name: 'manifest_digest', allowed: false },
      { column_name: 'normalizer_version', allowed: false },
      { column_name: 'output_event_id', allowed: false },
      { column_name: 'run_id', allowed: false },
      { column_name: 'status', allowed: true },
      { column_name: 'updated_at', allowed: true },
    ]);
    expect(
      (
        await admin.query(
          "SELECT column_name,has_column_privilege('openbot_runtime','memory_candidates',column_name,'UPDATE') AS allowed FROM information_schema.columns WHERE table_schema='public' AND table_name='memory_candidates' ORDER BY column_name",
        )
      ).rows,
    ).toEqual([
      { column_name: 'confidence', allowed: false },
      { column_name: 'confidence_source', allowed: false },
      { column_name: 'created_at', allowed: false },
      { column_name: 'current_revision', allowed: true },
      { column_name: 'extractor_version', allowed: false },
      { column_name: 'id', allowed: false },
      { column_name: 'manifest_digest', allowed: false },
      { column_name: 'normalized_fingerprint', allowed: false },
      { column_name: 'origin_bot_version_id', allowed: false },
      { column_name: 'origin_task_id', allowed: false },
      { column_name: 'output_event_id', allowed: false },
      { column_name: 'proposed_scope_id', allowed: false },
      { column_name: 'proposed_scope_kind', allowed: false },
      { column_name: 'run_id', allowed: false },
      { column_name: 'status', allowed: true },
      { column_name: 'workspace_id', allowed: false },
    ]);
    for (const fn of [
      'protect_group_memory()',
      'protect_memory_version()',
      'protect_run_memory_reference()',
      'protect_bot_private_memory()',
      'protect_memory_promotion_confirmation()',
      'protect_run_private_memory_reference()',
      'protect_run_source_manifest()',
      'protect_run_source_manifest_item()',
      'protect_memory_extraction_job()',
      'protect_memory_candidate()',
      'protect_memory_candidate_revision()',
      'protect_memory_candidate_update()',
      'protect_approved_memory_fact()',
      'protect_memory_candidate_decision()',
      'protect_memory_candidate_review_confirmation()',
      'protect_run_approved_fact_reference()',
    ])
      expect(
        (
          await admin.query('SELECT has_function_privilege($1,$2,$3) AS allowed', [
            'openbot_runtime',
            fn,
            'EXECUTE',
          ])
        ).rows[0].allowed,
      ).toBe(false);
    await expect(
      admin.query('UPDATE memory_versions SET confidence=0.9 WHERE id=$1', [saved.versionId]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      runtime.query(
        'INSERT INTO group_memories(id,workspace_id,group_id,conversation_id,creator_user_id,created_at,idempotency_key,command_hash) VALUES($1,$2,$3,$4,$5,NOW(),$6,$7)',
        [
          randomUUID(),
          f.workspaceId,
          other.group.id,
          f.conversation.id,
          f.memberId,
          randomUUID(),
          '0'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(rawVersion(f, other.source.eventId)).rejects.toMatchObject({ code: '23514' });
    await f.conversations.edit(f.ownerId, f.workspaceId, f.conversation.id, f.source.messageId, {
      expectedVersion: 1,
      idempotencyKey: 'edit',
      body: 'Current source differs.',
    });
    await expect(rawVersion(f)).rejects.toMatchObject({ code: '23514' });
    expect(await counts(f)).toEqual({ memories: 1, versions: 1, audits: 1 });
  });
  it('matches percent, underscore and backslash literally with native PostgreSQL ILIKE semantics', async () => {
    const f = await fixture(),
      saved = [];
    for (const body of ['marker literal%_value\\path', 'marker literalXXvalueZpath']) {
      const source = await f.conversations.append(f.ownerId, f.workspaceId, f.conversation.id, {
        body,
        idempotencyKey: randomUUID(),
      });
      saved.push(
        (
          await f.memories.create(f.access, {
            ...f.command,
            messageId: source.messageId,
            expectedSourceEventId: source.eventId,
            idempotencyKey: randomUUID(),
          })
        ).memory,
      );
    }
    for (const query of ['%_', '\\path', 'LITERAL%_'])
      expect((await f.memories.list(f.access, { query }, true)).memories.map((m) => m.id)).toEqual([
        saved[0]!.id,
      ]);
  });
  it('re-admits current membership after an observed lock wait before saving', async () => {
    const f = await fixture();
    const result = await duringWorkspaceWait(
      f,
      (pool) => new MemoryService(pool).create(f.access, f.command),
      (connection) =>
        connection.query('DELETE FROM group_memberships WHERE group_id=$1 AND user_id=$2', [
          f.group.id,
          f.memberId,
        ]),
    );
    expect(result).toMatchObject({ status: 'rejected', reason: expect.any(MemoryAccessError) });
    expect(await counts(f)).toEqual({ memories: 0, versions: 0, audits: 0 });
    expect(
      (
        await admin.query(
          "SELECT id FROM audit_events WHERE event_type='memory.access_denied' AND actor_user_id=$1",
          [f.memberId],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('rejects an old source reference after an observed edit lock wait, including its source author', async () => {
    const f = await fixture(),
      memory = (await f.memories.create(f.access, f.command)).memory;
    const result = await duringWorkspaceWait(
      f,
      (pool) => new MemoryService(pool).get({ ...f.access, actorUserId: f.ownerId }, memory.id),
      async (connection) =>
        (
          await ConversationTransaction.lock(
            connection,
            {
              actorUserId: f.ownerId,
              workspaceId: f.workspaceId,
              conversationId: f.conversation.id,
            },
            () => new Date(),
            'use',
          )
        ).edit(f.source.messageId, {
          idempotencyKey: 'concurrent-edit',
          expectedVersion: 1,
          body: 'Current replacement source',
        }),
    );
    expect(result).toMatchObject({ status: 'rejected', reason: expect.any(MemoryAccessError) });
    expect(
      (
        await admin.query(
          'SELECT event_type,message_version,body FROM conversation_events WHERE conversation_id=$1 AND message_id=$2 ORDER BY sequence',
          [f.conversation.id, f.source.messageId],
        )
      ).rows,
    ).toEqual([
      { event_type: 'message.created', message_version: 1, body: 'Native cobalt evidence.' },
      { event_type: 'message.edited', message_version: 2, body: 'Current replacement source' },
    ]);
    expect((await f.memories.list(f.access, {})).memories).toEqual([]);
  });
  it('records exactly claimed source IDs, rejects forged Run provenance, and rolls back failed terminal publication', async () => {
    const f = await fixture(),
      memory = (await f.memories.create(f.access, f.command)).memory,
      e = await execution(f),
      other = await fixture(),
      otherMemory = (await other.memories.create(other.access, other.command)).memory;
    await expect(
      runtime.query(
        'INSERT INTO run_memory_references(run_id,memory_version_id,source_event_id,selected_at) VALUES($1,$2,$3,NOW())',
        [e.runId, memory.versionId, f.source.eventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const queue = new TaskQueue(runtime),
      claim = (await queue.claimNext()).claim!;
    claims.push(claim);
    expect(claim.runId).toBe(e.runId);
    expect(
      JSON.parse(
        claim.messages.find((m) => m.content.startsWith('{"kind":"group_memories"'))!.content,
      ),
    ).toMatchObject({
      memories: [{ versionId: memory.versionId, source: { eventId: f.source.eventId } }],
    });
    await expect(
      runtime.query(
        'INSERT INTO run_memory_references(run_id,memory_version_id,source_event_id,selected_at) VALUES($1,$2,$3,NOW())',
        [e.runId, otherMemory.versionId, other.source.eventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const refs = (
      await admin.query('SELECT * FROM run_memory_references WHERE run_id=$1', [e.runId])
    ).rows;
    expect(refs).toHaveLength(1);
    expect(JSON.stringify(refs)).not.toContain('cobalt');
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(
        queue.finish(claim, { body: 'Failed audit answer', usage: null }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(
      (await admin.query('SELECT status,output_event_id FROM task_runs WHERE id=$1', [e.runId]))
        .rows,
    ).toEqual([{ status: 'running', output_event_id: null }]);
    expect(
      (
        await admin.query(
          "SELECT id FROM conversation_events WHERE conversation_id=$1 AND event_type='bot.message.created'",
          [f.conversation.id],
        )
      ).rows,
    ).toEqual([]);
    expect(await queue.finish(claim, { body: 'Authorized memory answer', usage: null })).toBe(true);
    expect(
      (await admin.query('SELECT * FROM run_memory_references WHERE run_id=$1', [e.runId])).rows,
    ).toEqual(refs);
  });
  it.each([
    'source-edit',
    'source-tombstone',
    'execution-human',
    'grantor-use',
    'closed-exact-grant',
  ] as const)(
    'stops later deltas and final output after %s changes during provider work',
    async (change) => {
      const f = await fixture();
      await f.memories.create(f.access, f.command);
      const e = await execution(f);
      const worker = new TaskWorker(runtime, {
        secrets,
        createAdapter: () => ({
          generate: async (_input, _signal, onEvent) => {
            await onEvent?.({ type: 'text', text: 'Legitimate earlier delta.' });
            if (change === 'source-edit')
              await f.conversations.edit(
                f.ownerId,
                f.workspaceId,
                f.conversation.id,
                f.source.messageId,
                { expectedVersion: 1, idempotencyKey: 'edit', body: 'Revised source' },
              );
            if (change === 'source-tombstone')
              await f.conversations.tombstone(
                f.ownerId,
                f.workspaceId,
                f.conversation.id,
                f.source.messageId,
                { expectedVersion: 1, idempotencyKey: 'delete' },
              );
            if (change === 'execution-human')
              await f.groups.removeMember(f.ownerId, f.workspaceId, f.group.id, f.memberId);
            if (change === 'grantor-use')
              await e.acl.revoke(f.ownerId, f.workspaceId, e.bot.id, f.grantorId);
            if (change === 'closed-exact-grant') {
              await e.grants.remove(f.ownerId, f.workspaceId, f.group.id, e.grant.id, {
                idempotencyKey: 'remove',
              });
              await e.grants.invite(f.ownerId, f.workspaceId, f.group.id, {
                botId: e.bot.id,
                idempotencyKey: 'replacement',
                history: { mode: 'all' },
              });
            }
            await onEvent?.({ type: 'text', text: 'stale'.repeat(1000) });
            return {
              events: [
                { type: 'text', text: 'Must not publish' },
                { type: 'complete', stopReason: 'stop' },
              ],
              raw: '',
            };
          },
        }),
      });
      expect(await worker.runOnce()).toBe(true);
      expect(
        (
          await admin.query('SELECT status,error_code,output_event_id FROM task_runs WHERE id=$1', [
            e.runId,
          ])
        ).rows,
      ).toEqual([{ status: 'failed', error_code: 'execution_forbidden', output_event_id: null }]);
      expect(
        (
          await admin.query(
            "SELECT delta_text FROM conversation_delivery_events WHERE run_id=$1 AND event_type='assistant.delta' ORDER BY sequence",
            [e.runId],
          )
        ).rows,
      ).toEqual([{ delta_text: 'Legitimate earlier delta.' }]);
      expect(
        (await admin.query('SELECT run_id FROM run_memory_references WHERE run_id=$1', [e.runId]))
          .rows,
      ).toHaveLength(1);
    },
  );
  it('excludes the original source below an exact grant lower bound despite a later edit and saved revision', async () => {
    const f = await fixture(),
      e = await execution(f, 'future-only');
    const edit = await f.conversations.edit(
      f.ownerId,
      f.workspaceId,
      f.conversation.id,
      f.source.messageId,
      { expectedVersion: 1, idempotencyKey: 'late-edit', body: 'Still originally excluded.' },
    );
    await f.memories.create(f.access, { ...f.command, expectedSourceEventId: edit.eventId });
    const claim = (await new TaskQueue(runtime).claimNext()).claim!;
    claims.push(claim);
    expect(claim.messages.some((m) => m.content.includes('Still originally excluded.'))).toBe(
      false,
    );
    expect(
      (await admin.query('SELECT run_id FROM run_memory_references WHERE run_id=$1', [e.runId]))
        .rows,
    ).toEqual([]);
    expect(
      (await f.memories.list({ ...f.access, grantId: e.grant.id }, { query: 'excluded' }, true))
        .memories,
    ).toEqual([]);
  });
  it('excludes a pending purge immediately and leaves no copied memory body after original and derivative cleanup', async () => {
    const f = await fixture(),
      directory = await mkdtemp(join(tmpdir(), 'openbot-native-memory-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new LocalObjectStore(directory, { maxObjectBytes: 10485760 }),
      attachments = new AttachmentService(runtime, store),
      bytes = Buffer.from('Private memory source attachment');
    const attachmentAccess = {
      actorUserId: f.ownerId,
      workspaceId: f.workspaceId,
      conversationId: f.conversation.id,
    };
    const command = {
      body: 'Attachment memory source to purge.',
      filename: 'source.txt',
      mediaType: 'text/plain',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      idempotencyKey: 'upload',
    };
    const source = await attachments.upload(attachmentAccess, command, bytes);
    await attachments.registerDerived(
      attachmentAccess,
      source.messageId,
      { ...command, filename: 'derived.txt' },
      bytes,
    );
    const memory = (
      await f.memories.create(f.access, {
        ...f.command,
        messageId: source.messageId,
        expectedSourceEventId: source.eventId,
      })
    ).memory;
    const e = await execution(f),
      queue = new TaskQueue(runtime),
      claim = (await queue.claimNext()).claim!;
    claims.push(claim);
    await attachments.purge(attachmentAccess, source.messageId);
    await expect(f.memories.get(f.access, memory.id)).rejects.toThrow(MemoryAccessError);
    expect(
      (await admin.query('SELECT body FROM conversation_events WHERE id=$1', [source.eventId]))
        .rows[0].body,
    ).toBe(command.body);
    const retainedEvents = (
      await admin.query(
        'SELECT id,message_id,event_type,sequence,actor_user_id FROM conversation_events WHERE conversation_id=$1 AND message_id=$2 ORDER BY sequence',
        [f.conversation.id, source.messageId],
      )
    ).rows;
    expect(retainedEvents.map((row) => row.event_type)).toEqual([
      'message.created',
      'message.deleted',
    ]);
    await attachments.cleanup(100);
    expect(
      (
        await admin.query(
          'SELECT state FROM message_purges WHERE conversation_id=$1 AND message_id=$2',
          [f.conversation.id, source.messageId],
        )
      ).rows,
    ).toEqual([{ state: 'complete' }]);
    expect(
      (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) =>
        entry.isFile(),
      ),
    ).toEqual([]);
    expect(
      (
        await admin.query(
          'SELECT id,message_id,event_type,sequence,actor_user_id,body,reason,command_hash FROM conversation_events WHERE conversation_id=$1 AND message_id=$2 ORDER BY sequence',
          [f.conversation.id, source.messageId],
        )
      ).rows,
    ).toEqual(
      retainedEvents.map((row) => ({
        ...row,
        body: null,
        reason: null,
        command_hash: '0'.repeat(64),
      })),
    );
    expect((await f.memories.list(f.access, {})).memories).toEqual([]);
    await expect(
      f.memories.create(f.access, {
        ...f.command,
        messageId: source.messageId,
        expectedSourceEventId: source.eventId,
      }),
    ).rejects.toThrow(MemoryAccessError);
    expect(await queue.finish(claim, { body: 'Stale result', usage: null })).toBe(true);
    expect(
      (await admin.query('SELECT error_code,output_event_id FROM task_runs WHERE id=$1', [e.runId]))
        .rows,
    ).toEqual([{ error_code: 'execution_forbidden', output_event_id: null }]);
    expect(
      (
        await admin.query('SELECT source_event_id FROM run_memory_references WHERE run_id=$1', [
          e.runId,
        ])
      ).rows,
    ).toEqual([{ source_event_id: source.eventId }]);
  });
  it('previews source, destination Bot, visibility and content, then promotes only after an explicit owner confirmation', async () => {
    const f = await fixture(),
      memory = (await f.memories.create(f.access, f.command)).memory,
      { dest, ownerAccess } = await provisionBots(f),
      owner = await f.headers(f.ownerId),
      member = await f.headers(),
      outsider = await f.headers(f.outsiderId);
    const preview = await f.app.inject({
      method: 'POST',
      url: `${f.path}/${memory.id}/promotion-previews`,
      headers: owner,
      payload: { destinationBotId: dest.id },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({
      source: { groupId: f.group.id, memoryId: memory.id, text: memory.text },
      destinationBot: { id: dest.id, name: 'Private destination' },
      visibility: {
        kind: 'bot-private',
        botId: dest.id,
        summary: BOT_PRIVATE_VISIBILITY_SUMMARY,
      },
      content: memory.text,
    });
    expect(
      (
        await admin.query('SELECT id FROM bot_private_memories WHERE workspace_id=$1', [
          f.workspaceId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/${memory.id}/promotions`,
          headers: owner,
          payload: {
            intentId: preview.json().preview.id,
            idempotencyKey: 'native-promote',
            acknowledged: false,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/${memory.id}/promotion-previews`,
          headers: member,
          payload: { destinationBotId: dest.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/${memory.id}/promotion-previews`,
          headers: outsider,
          payload: { destinationBotId: dest.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await admin.query('SELECT id FROM bot_private_memories WHERE workspace_id=$1', [
          f.workspaceId,
        ])
      ).rows,
    ).toEqual([]);
    const confirmed = await f.app.inject({
      method: 'POST',
      url: `${f.path}/${memory.id}/promotions`,
      headers: owner,
      payload: {
        intentId: preview.json().preview.id,
        idempotencyKey: 'native-promote',
        acknowledged: true,
      },
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().memory).toMatchObject({
      version: 1,
      scope: { kind: 'bot-private', workspaceId: f.workspaceId, botId: dest.id },
      sourceGroupId: f.group.id,
      sourceMemoryId: memory.id,
      approver: { id: f.ownerId },
      text: memory.text,
    });
    expect(Date.parse(String(confirmed.json().memory.approvedAt))).toBeGreaterThan(0);
    expect(
      (
        await admin.query(
          "SELECT metadata FROM audit_events WHERE event_type='memory.promoted' AND actor_user_id=$1",
          [f.ownerId],
        )
      ).rows,
    ).toMatchObject([{ metadata: { sourceMemoryId: memory.id, botId: dest.id } }]);
    expect(
      JSON.stringify(
        (await admin.query("SELECT metadata FROM audit_events WHERE event_type='memory.promoted'"))
          .rows,
      ),
    ).not.toContain('cobalt');
    const stale = new MemoryService(runtime, () => new Date(Date.now() + 6 * 60 * 1000));
    const expiredPreview = await new MemoryService(
      runtime,
      () => new Date(Date.now() - 6 * 60 * 1000),
    ).preview(ownerAccess, memory.id, { destinationBotId: dest.id });
    await expect(
      stale.confirm(ownerAccess, memory.id, {
        intentId: expiredPreview.preview.id,
        idempotencyKey: 'expired-promote',
        acknowledged: true,
      }),
    ).rejects.toThrow(MemoryAccessError);
    expect(
      (await admin.query('SELECT id FROM bot_private_memories WHERE bot_id=$1', [dest.id])).rows,
    ).toHaveLength(1);
  });
  it('refuses forged private-memory provenance and expired confirmation under the runtime role', async () => {
    const f = await fixture(),
      memory = (await f.memories.create(f.access, f.command)).memory,
      { dest, other, ownerAccess } = await provisionBots(f),
      otherFixture = await fixture();
    await expect(rawPrivateInsert(f, memory.id, dest.id, f.memberId)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(rawPrivateInsert(f, memory.id, dest.id, f.outsiderId)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      rawPrivateInsert(f, memory.id, dest.id, f.ownerId, otherFixture.source.eventId),
    ).rejects.toMatchObject({ code: '23514' });
    const promoted = (
      await f.memories.confirm(ownerAccess, memory.id, {
        intentId: (await f.memories.preview(ownerAccess, memory.id, { destinationBotId: dest.id }))
          .preview.id,
        idempotencyKey: 'guard-promote',
        acknowledged: true,
      })
    ).memory;
    const expiredIntent = randomUUID();
    await runtime.query(
      "INSERT INTO memory_promotion_intents(id,workspace_id,actor_user_id,source_group_id,source_memory_id,destination_bot_id,content_hash,lineage_digest,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()-INTERVAL '1 minute',NOW())",
      [
        expiredIntent,
        f.workspaceId,
        f.ownerId,
        f.group.id,
        memory.id,
        dest.id,
        '0'.repeat(64),
        '1'.repeat(64),
      ],
    );
    await expect(
      runtime.query(
        'INSERT INTO memory_promotion_confirmations(intent_id,private_memory_id,confirmed_at) VALUES($1,$2,NOW())',
        [expiredIntent, promoted.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      runtime.query(
        'INSERT INTO memory_promotion_confirmations(intent_id,private_memory_id,confirmed_at) VALUES($1,$2,NOW())',
        [
          (
            await runtime.query<{ id: string }>(
              "INSERT INTO memory_promotion_intents(id,workspace_id,actor_user_id,source_group_id,source_memory_id,destination_bot_id,content_hash,lineage_digest,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()+INTERVAL '5 minutes',NOW()) RETURNING id",
              [
                randomUUID(),
                f.workspaceId,
                f.ownerId,
                f.group.id,
                memory.id,
                other.id,
                '0'.repeat(64),
                '1'.repeat(64),
              ],
            )
          ).rows[0]!.id,
          promoted.id,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query('UPDATE bot_private_memories SET version=1 WHERE id=$1', [promoted.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('serializes competing confirms to one private memory and rolls back when the mandatory promotion audit cannot write', async () => {
    const f = await fixture(),
      memory = (await f.memories.create(f.access, f.command)).memory,
      { dest, ownerAccess } = await provisionBots(f),
      intentId = (await f.memories.preview(ownerAccess, memory.id, { destinationBotId: dest.id }))
        .preview.id;
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.memories.confirm(ownerAccess, memory.id, {
          intentId,
          idempotencyKey: 'compete-promote',
          acknowledged: true,
        }),
      ),
    );
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect(receipts.every((receipt) => receipt.memory.id === receipts[0]!.memory.id)).toBe(true);
    expect(
      (await admin.query('SELECT id FROM bot_private_memories WHERE bot_id=$1', [dest.id])).rows,
    ).toHaveLength(1);
    expect(
      (
        await admin.query(
          "SELECT id FROM audit_events WHERE event_type='memory.promoted' AND metadata->>'botId'=$1",
          [dest.id],
        )
      ).rows,
    ).toHaveLength(1);
    const other = await fixture(),
      otherMemory = (await other.memories.create(other.access, other.command)).memory,
      otherBots = await provisionBots(other),
      otherIntent = (
        await other.memories.preview(otherBots.ownerAccess, otherMemory.id, {
          destinationBotId: otherBots.dest.id,
        })
      ).preview.id;
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(
        other.memories.confirm(otherBots.ownerAccess, otherMemory.id, {
          intentId: otherIntent,
          idempotencyKey: 'audit-fail-promote',
          acknowledged: true,
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(
      (
        await admin.query('SELECT id FROM bot_private_memories WHERE bot_id=$1', [
          otherBots.dest.id,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query(
          'SELECT intent_id FROM memory_promotion_confirmations WHERE intent_id=$1',
          [otherIntent],
        )
      ).rows,
    ).toEqual([]);
  });
  it('lets the destination Bot use the promoted memory in another group and records zero private references for every other Bot', async () => {
    const f = await fixture(),
      memory = (await f.memories.create(f.access, f.command)).memory,
      { dest, other, grants, ownerAccess } = await provisionBots(f);
    const promoted = (
      await f.memories.confirm(ownerAccess, memory.id, {
        intentId: (await f.memories.preview(ownerAccess, memory.id, { destinationBotId: dest.id }))
          .preview.id,
        idempotencyKey: 'cross-group-promote',
        acknowledged: true,
      })
    ).memory;
    expect(
      (await f.memories.listPrivate({ ...ownerAccess, botId: dest.id }, { query: 'cobalt' }, true))
        .memories,
    ).toMatchObject([{ id: promoted.id, sourceMemoryId: memory.id, sourceGroupId: f.group.id }]);
    expect(
      (await f.memories.listPrivate({ ...ownerAccess, botId: other.id }, { query: 'cobalt' }, true))
        .memories,
    ).toEqual([]);
    const second = await f.groups.create(f.ownerId, f.workspaceId, { name: 'Second native group' });
    const destGrant = await grants.invite(f.ownerId, f.workspaceId, second.id, {
      botId: dest.id,
      idempotencyKey: 'dest-other-group',
      history: { mode: 'all' },
    });
    const otherGrant = await grants.invite(f.ownerId, f.workspaceId, second.id, {
      botId: other.id,
      idempotencyKey: 'other-bot',
      history: { mode: 'all' },
    });
    const tasks = new TaskService(runtime);
    const destTask = await tasks.submit(f.ownerId, f.workspaceId, destGrant.conversationId, {
      body: 'Use private memory.',
      groupGrantId: destGrant.id,
      idempotencyKey: 'dest-run',
    });
    const otherTask = await tasks.submit(f.ownerId, f.workspaceId, otherGrant.conversationId, {
      body: 'Do not see private memory.',
      groupGrantId: otherGrant.id,
      idempotencyKey: 'other-run',
    });
    const queue = new TaskQueue(runtime);
    const first = (await queue.claimNext()).claim!;
    claims.push(first);
    const secondClaim = (await queue.claimNext()).claim!;
    claims.push(secondClaim);
    const destClaim = first.runId === destTask.runs[0]!.id ? first : secondClaim;
    const otherClaim = destClaim.runId === first.runId ? secondClaim : first;
    expect(destClaim.runId).toBe(destTask.runs[0]!.id);
    expect(otherClaim.runId).toBe(otherTask.runs[0]!.id);
    expect(
      JSON.parse(
        destClaim.messages.find((message) =>
          message.content.startsWith('{"kind":"bot_private_memories"'),
        )!.content,
      ),
    ).toMatchObject({
      memories: [{ id: promoted.id, text: memory.text, source_memory_id: memory.id }],
    });
    expect(
      destClaim.messages.some((message) => message.content.includes('{"kind":"group_memories"')),
    ).toBe(false);
    expect(
      otherClaim.messages.some((message) =>
        message.content.startsWith('{"kind":"bot_private_memories"'),
      ),
    ).toBe(false);
    expect(
      (
        await admin.query(
          'SELECT private_memory_id FROM run_private_memory_references WHERE run_id=$1',
          [destClaim.runId],
        )
      ).rows,
    ).toEqual([{ private_memory_id: promoted.id }]);
    expect(
      (
        await admin.query(
          'SELECT private_memory_id FROM run_private_memory_references WHERE run_id=$1',
          [otherClaim.runId],
        )
      ).rows,
    ).toEqual([]);
    await expect(
      runtime.query(
        'INSERT INTO run_private_memory_references(run_id,private_memory_id,source_event_id,selected_at) VALUES($1,$2,$3,NOW())',
        [otherClaim.runId, promoted.id, f.source.eventId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      JSON.stringify(
        (
          await admin.query('SELECT * FROM run_private_memory_references WHERE run_id=$1', [
            destClaim.runId,
          ])
        ).rows,
      ),
    ).not.toContain('cobalt');
  });
  it('enqueues extraction from a successful Run and approves the pending same-group candidate', async () => {
    const f = await fixture(),
      e = await execution(f),
      owner = await f.headers(f.ownerId);
    expect(
      await new TaskWorker(runtime, {
        secrets,
        createAdapter: () => ({
          generate: async () => ({
            events: [
              { type: 'text', text: 'Remember: native reviewed evidence.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          }),
        }),
      }).runOnce(),
    ).toBe(true);
    expect(
      (await runtime.query('SELECT status FROM memory_extraction_jobs WHERE run_id=$1', [e.runId]))
        .rows,
    ).toEqual([{ status: 'completed' }]);
    const inbox = `/api/v1/workspaces/${f.workspaceId}/conversations/${f.conversation.id}/memory-candidates`;
    const listed = await f.app.inject({ method: 'GET', url: inbox, headers: owner });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().candidates).toEqual([
      expect.objectContaining({
        status: 'pending',
        body: 'native reviewed evidence.',
        proposedScope: { kind: 'group', id: f.group.id },
      }),
    ]);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/search`,
          headers: owner,
          payload: { query: 'reviewed evidence' },
        })
      ).json().memories,
    ).toEqual([]);
    const approved = await f.app.inject({
      method: 'POST',
      url: `${inbox}/${listed.json().candidates[0]!.id}/approvals`,
      headers: owner,
      payload: {
        expectedRevision: listed.json().candidates[0]!.revision,
        destination: { kind: 'group', id: f.group.id },
        confidence: 0.8,
        idempotencyKey: 'native-approve',
      },
    });
    expect(approved.statusCode).toBe(201);
    expect(approved.json()).toMatchObject({
      replayed: false,
      candidate: { status: 'approved' },
      fact: {
        kind: 'approved_fact',
        text: 'native reviewed evidence.',
        scope: { kind: 'group', workspaceId: f.workspaceId, id: f.group.id },
      },
    });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/search`,
          headers: owner,
          payload: { query: 'reviewed evidence' },
        })
      ).json().memories,
    ).toEqual([
      expect.objectContaining({
        kind: 'approved_fact',
        text: 'native reviewed evidence.',
      }),
    ]);
  });
  it('serializes competing approve and reject to one candidate decision and rolls back when the review audit cannot write', async () => {
    const f = await fixture();
    await execution(f);
    expect(
      await new TaskWorker(runtime, {
        secrets,
        createAdapter: () => ({
          generate: async () => ({
            events: [
              { type: 'text', text: 'Remember: native reviewed fact.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          }),
        }),
      }).runOnce(),
    ).toBe(true);
    const candidate = (
      await admin.query<{ id: string; current_revision: number }>(
        `SELECT c.id,c.current_revision FROM memory_candidates c
         JOIN tasks t ON t.id=c.origin_task_id WHERE t.conversation_id=$1`,
        [f.conversation.id],
      )
    ).rows[0]!;
    const access = {
      actorUserId: f.memberId,
      workspaceId: f.workspaceId,
      conversationId: f.conversation.id,
    };
    const destination = { kind: 'group' as const, id: f.group.id };
    const raced = await Promise.allSettled([
      f.memories.approveCandidate(access, candidate.id, {
        expectedRevision: Number(candidate.current_revision),
        destination,
        confidence: 0.8,
        idempotencyKey: 'native-approve-race',
      }),
      f.memories.rejectCandidate(access, candidate.id, {
        expectedRevision: Number(candidate.current_revision),
        idempotencyKey: 'native-reject-race',
      }),
    ]);
    const accepted = raced.filter((result) => result.status === 'fulfilled');
    const denied = raced.filter((result) => result.status === 'rejected');
    expect(raced.map((result) => result.status)).toEqual(
      expect.arrayContaining(['fulfilled', 'rejected']),
    );
    expect(accepted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      status: 'rejected',
      reason: expect.any(MemoryConflictError),
    });
    const decided = (
      await admin.query<{ decision: string; approved_fact_id: string | null }>(
        'SELECT decision,approved_fact_id FROM memory_candidate_decisions WHERE candidate_id=$1',
        [candidate.id],
      )
    ).rows;
    expect(decided).toHaveLength(1);
    expect(
      (await admin.query('SELECT status FROM memory_candidates WHERE id=$1', [candidate.id])).rows,
    ).toEqual([{ status: decided[0]!.decision }]);
    expect(
      (
        await admin.query('SELECT id FROM approved_memory_facts WHERE candidate_id=$1', [
          candidate.id,
        ])
      ).rows,
    ).toHaveLength(decided[0]!.decision === 'approved' ? 1 : 0);
    const other = await fixture();
    const otherExec = await execution(other);
    expect(
      await new TaskWorker(runtime, {
        secrets,
        createAdapter: () => ({
          generate: async () => ({
            events: [
              { type: 'text', text: 'Remember: audit must roll back.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          }),
        }),
      }).runOnce(),
    ).toBe(true);
    const pending = (
      await admin.query<{ id: string; current_revision: number }>(
        `SELECT c.id,c.current_revision FROM memory_candidates c
         JOIN tasks t ON t.id=c.origin_task_id WHERE t.conversation_id=$1`,
        [other.conversation.id],
      )
    ).rows[0]!;
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(
        other.memories.approveCandidate(
          {
            actorUserId: other.memberId,
            workspaceId: other.workspaceId,
            conversationId: other.conversation.id,
          },
          pending.id,
          {
            expectedRevision: Number(pending.current_revision),
            destination: { kind: 'group', id: other.group.id },
            confidence: 0.55,
            idempotencyKey: 'native-audit-fail',
          },
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(
      (await admin.query('SELECT status FROM memory_candidates WHERE id=$1', [pending.id])).rows,
    ).toEqual([{ status: 'pending' }]);
    expect(
      (
        await admin.query(
          'SELECT candidate_id FROM memory_candidate_decisions WHERE candidate_id=$1',
          [pending.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query('SELECT id FROM approved_memory_facts WHERE candidate_id=$1', [
          pending.id,
        ])
      ).rows,
    ).toEqual([]);
    expect(otherExec.task.id).toBeTruthy();
  });
  it('lets only one native extraction worker complete a leftover job and candidate', async () => {
    const f = await fixture();
    await execution(f);
    const queue = new TaskQueue(runtime);
    const claim = (await queue.claimNext()).claim!;
    expect(claim).toBeDefined();
    expect(
      await queue.finish(claim, { body: 'Remember: native dual worker evidence.', usage: null }),
    ).toBe(true);
    expect(
      (
        await admin.query('SELECT status FROM memory_extraction_jobs WHERE run_id=$1', [
          claim.runId,
        ])
      ).rows,
    ).toEqual([{ status: 'queued' }]);
    const raced = await Promise.all([
      new ExtractionWorker(runtime).runOnce(),
      new ExtractionWorker(runtime).runOnce(),
    ]);
    expect(raced.some(Boolean)).toBe(true);
    expect(
      (
        await admin.query('SELECT status FROM memory_extraction_jobs WHERE run_id=$1', [
          claim.runId,
        ])
      ).rows,
    ).toEqual([{ status: 'completed' }]);
    expect(
      (
        await admin.query(
          `SELECT c.status,r.body FROM memory_candidates c
           JOIN memory_candidate_revisions r ON r.candidate_id=c.id AND r.revision=c.current_revision
           WHERE c.run_id=$1`,
          [claim.runId],
        )
      ).rows,
    ).toEqual([{ status: 'pending', body: 'native dual worker evidence.' }]);
  });
  it('cites matching scoped knowledge through PostgreSQL full-text search without an embedding service', async () => {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), 'openbot-native-knowledge-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const attachments = new AttachmentService(
      runtime,
      new LocalObjectStore(directory, { maxObjectBytes: 10485760 }),
    );
    const knowledge = new KnowledgeService(runtime, attachments);
    const bytes = Buffer.from('Quarterly notes\nKeep the cobalt key\n');
    const uploaded = await attachments.upload(
      {
        actorUserId: f.ownerId,
        workspaceId: f.workspaceId,
        conversationId: f.conversation.id,
      },
      {
        body: 'Promote these notes',
        filename: 'notes.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        idempotencyKey: 'native-knowledge',
      },
      bytes,
    );
    expect(
      (
        await knowledge.promote(
          {
            actorUserId: f.ownerId,
            workspaceId: f.workspaceId,
            conversationId: f.conversation.id,
          },
          uploaded.messageId,
          {
            destination: { kind: 'group', id: f.group.id },
            idempotencyKey: 'native-promote',
            acknowledged: true,
          },
        )
      ).created,
    ).toBe(true);
    const fts = await runtime.query<{ text: string }>(
      `SELECT c.text FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id=c.document_id
       WHERE d.workspace_id=$1 AND d.scope_kind='group' AND d.scope_id=$2
         AND to_tsvector('simple', c.text) @@ to_tsquery('simple', 'cobalt | key')
       ORDER BY ts_rank(to_tsvector('simple', c.text), to_tsquery('simple', 'cobalt | key')) DESC, c.id`,
      [f.workspaceId, f.group.id],
    );
    expect(fts.rows.map((row) => row.text)).toEqual(['Keep the cobalt key']);
    expect(
      (await runtime.query('SELECT knowledge_fts_match($1,$2) AS ok', ['somewhat later', 'what']))
        .rows,
    ).toEqual([{ ok: false }]);
    expect(
      (
        await runtime.query('SELECT knowledge_fts_match($1,$2) AS ok', [
          'Keep the cobalt key',
          'what | cobalt',
        ])
      ).rows,
    ).toEqual([{ ok: true }]);
    expect(
      (
        await knowledge.search(
          { actorUserId: f.memberId, workspaceId: f.workspaceId },
          { query: 'Where is the cobalt key kept?', scope: { kind: 'group', id: f.group.id } },
        )
      ).chunks.map((chunk) => chunk.text),
    ).toEqual(['Keep the cobalt key']);
    expect(
      await knowledge.search(
        { actorUserId: f.outsiderId, workspaceId: f.workspaceId },
        { query: 'Where is the cobalt key kept?', scope: { kind: 'group', id: f.group.id } },
      ),
    ).toEqual({ chunks: [] });
    await execution(f, 'all', 'Where is the cobalt key kept?');
    const queue = new TaskQueue(runtime);
    const claim = (await queue.claimNext()).claim!;
    claims.push(claim);
    const knowledgeMessage = claim.messages.find((message) =>
      message.content.includes('"kind":"scoped_knowledge"'),
    );
    expect(knowledgeMessage).toBeDefined();
    expect(JSON.parse(knowledgeMessage!.content)).toMatchObject({
      kind: 'scoped_knowledge',
      untrusted: true,
      warning: UNTRUSTED_KNOWLEDGE_WARNING,
      chunks: [{ text: 'Keep the cobalt key', locator: { kind: 'line', start: 2, end: 2 } }],
    });
    expect(JSON.stringify(claim.messages)).not.toContain('Quarterly notes');
    expect(
      (
        await runtime.query('SELECT chunk_id FROM run_knowledge_references WHERE run_id=$1', [
          claim.runId,
        ])
      ).rows,
    ).toHaveLength(1);
  });
});

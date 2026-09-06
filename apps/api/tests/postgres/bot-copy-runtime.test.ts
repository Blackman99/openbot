import { BotLifecycleService } from '../../src/bots/lifecycle-service.js';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BotAclService } from '../../src/bots/acl-service.js';
import {
  BotAvatarUnavailableError,
  BotVersionConflictError,
} from '../../src/bots/append-version.js';
import { BotAvatarService } from '../../src/bots/avatar-service.js';
import { BotCopyService } from '../../src/bots/copy-service.js';
import { PostgresBotAclRepository } from '../../src/bots/postgres-bot-acl-repository.js';
import { PostgresBotRepository } from '../../src/bots/postgres-bot-repository.js';
import { BotAccessError, BotModelError, BotService } from '../../src/bots/service.js';
import { BotVersionService } from '../../src/bots/version-service.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import { WorkspaceMemberService } from '../../src/members/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { ProviderConnections } from '../../src/providers/connections.js';
import { authorizeProviderScope } from '../../src/providers/postgres-provider-scope.js';
import { PostgresProviderRepository } from '../../src/providers/postgres-repository.js';
import { personalAccess } from '../../src/providers/scope.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ProviderUrlPolicy } from '../../src/providers/url-policy.js';

// Run in a separate sequential vitest command after the other Bot suites:
// the real provisioner rotates the fixed openbot_runtime role's password.
const databaseUrl = process.env.TEST_BOT_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Bot copy with deployed PostgreSQL permissions', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let runtime: pg.Pool;
  const directories: string[] = [];
  beforeAll(async () => {
    await migrateDatabase(admin);
    const url = new URL(databaseUrl!);
    const password = `ci-bot-copy-${randomBytes(24).toString('hex')}`;
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
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await runtime?.end();
    await admin.end();
  });

  const providerInput = {
    name: 'Copy fixture model',
    baseUrl: 'https://models.example/v1',
    modelId: 'copy-model',
    apiKey: 'native-copy-provider-secret',
    headers: { 'x-fixture-header': 'native-copy-header-secret' },
  };
  function providers() {
    return new ProviderConnections(
      new PostgresProviderRepository(runtime),
      new ProviderSecretBox(randomBytes(32).toString('base64')),
      new ProviderUrlPolicy({ hosts: ['models.example'], schemes: ['https'], privateCidrs: [] }),
      {
        // Only Basic capability evidence is a fixture. Authorization, deployed
        // grants, transactions, locks, immutable rows and filesystem I/O are real.
        run: async () => ({
          testedAt: new Date().toISOString(),
          text: { ok: true, code: 'passed', raw: 'OK' },
          action: { ok: false, code: 'provider_action_unsupported', raw: 'Unsupported' },
        }),
      },
    );
  }
  const acl = (pool = runtime) => new BotAclService(new PostgresBotAclRepository(pool));
  const bots = () => new BotService(new PostgresBotRepository(runtime));
  async function fixture(sourceScope: 'workspace' | 'personal' = 'workspace') {
    const ownerId = randomUUID(),
      actorId = randomUUID(),
      administratorId = randomUUID(),
      workspaceId = randomUUID();
    for (const id of [ownerId, actorId, administratorId])
      await runtime.query(
        'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
        [id, `${id}@example.com`, id === actorId ? 'Copy actor' : 'Source member'],
      );
    await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
      workspaceId,
      'Copy workspace',
    ]);
    for (const [id, role] of [
      [ownerId, 'owner'],
      [actorId, 'member'],
      [administratorId, 'administrator'],
    ])
      await runtime.query(
        'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
        [workspaceId, id, role],
      );
    const provider =
      sourceScope === 'workspace' ? providers().inWorkspace(workspaceId) : providers();
    const model = await provider.save(ownerId, providerInput);
    const bot = await bots().create(ownerId, workspaceId, {
      name: 'Evidence assistant',
      roleDescription: 'Researcher',
      description: 'Configuration to copy',
      instructions: 'Preserve source quotations.',
      limits: { maxTotalTokens: 4096, maxDurationSeconds: 90, maxTurns: 4, maxDelegationDepth: 1 },
      modelBinding: {
        scope: { kind: sourceScope, id: sourceScope === 'workspace' ? workspaceId : ownerId },
        connectionId: model.id,
        modelId: model.modelId,
      },
    });
    await acl().grant(ownerId, workspaceId, bot.id, { userId: actorId, role: 'user' });
    const directory = await mkdtemp(join(tmpdir(), 'openbot-copy-native-'));
    directories.push(directory);
    const store = new LocalObjectStore(directory),
      avatars = new BotAvatarService(runtime, store),
      copy = new BotCopyService(runtime);
    return {
      ownerId,
      actorId,
      administratorId,
      workspaceId,
      bot,
      copy,
      access: copy.access(actorId, workspaceId, bot.id),
      ownerAccess: copy.access(ownerId, workspaceId, bot.id),
      versionId: bot.currentVersion!.id,
      directory,
      store,
      avatars,
      versions: new BotVersionService(runtime, avatars),
    };
  }
  function observedPool() {
    const name = `bot-copy-${randomUUID()}`;
    return {
      name,
      pool: new pg.Pool({
        connectionString: runtime.options.connectionString,
        application_name: name,
        statement_timeout: 15000,
      }),
    };
  }
  async function waitForBlocked(name: string, blockerPid: number) {
    let pid = 0;
    await vi.waitFor(
      async () => {
        const result = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",
          [name, blockerPid],
        );
        expect(result.rows).toHaveLength(1);
        pid = result.rows[0]!.pid;
      },
      { timeout: 5000, interval: 20 },
    );
    return pid;
  }
  async function snapshot(workspaceId: string) {
    return {
      bots: (
        await admin.query('SELECT * FROM bots WHERE workspace_id=$1 ORDER BY id', [workspaceId])
      ).rows,
      versions: (
        await admin.query(
          'SELECT v.* FROM bot_versions v JOIN bots b ON b.id=v.bot_id WHERE b.workspace_id=$1 ORDER BY v.id',
          [workspaceId],
        )
      ).rows,
      acl: (
        await admin.query(
          'SELECT a.* FROM bot_acl a JOIN bots b ON b.id=a.bot_id WHERE b.workspace_id=$1 ORDER BY a.bot_id,a.user_id',
          [workspaceId],
        )
      ).rows,
      references: (
        await admin.query(
          'SELECT r.* FROM bot_avatar_references r JOIN bot_versions v ON v.id=r.version_id JOIN bots b ON b.id=v.bot_id WHERE b.workspace_id=$1 ORDER BY r.version_id',
          [workspaceId],
        )
      ).rows,
      objects: (
        await admin.query('SELECT * FROM avatar_objects WHERE workspace_id=$1 ORDER BY id', [
          workspaceId,
        ])
      ).rows,
      audits: (
        await admin.query(
          "SELECT * FROM audit_events WHERE metadata->>'workspaceId'=$1 ORDER BY id",
          [workspaceId],
        )
      ).rows,
    };
  }
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
    'base64',
  );

  it('previews without writes and copies current configuration into a private version one with only actor ownership', async () => {
    const f = await fixture();
    const edited = await f.versions.edit(f.ownerAccess, {
      expectedCurrentVersionId: f.versionId,
      changes: { instructions: 'Copy this current configuration only.' },
    });
    await acl().changeVisibility(f.ownerId, f.workspaceId, f.bot.id, { visibility: 'workspace' });
    const before = await snapshot(f.workspaceId);
    expect((await runtime.query('SELECT current_user AS role')).rows).toEqual([
      { role: 'openbot_runtime' },
    ]);
    const preview = await f.copy.preview(f.access);
    expect(preview).toMatchObject({
      sourceBotId: f.bot.id,
      sourceVersionId: edited.id,
      sourceVersionNumber: 2,
      configuration: edited.configuration,
      bindingStatus: { state: 'ready', chatOnly: true },
      included: ['identity', 'instructions', 'executionLimits', 'avatarReference', 'modelBinding'],
      excluded: ['credentials', 'acls', 'history', 'memory', 'fileContents', 'audits'],
    });
    expect(await snapshot(f.workspaceId)).toEqual(before);
    const copied = await f.copy.confirm(f.access, {
      expectedCurrentVersionId: preview.sourceVersionId,
    });
    expect(copied.id).not.toBe(f.bot.id);
    expect(copied.currentVersion!.id).not.toBe(edited.id);
    expect(copied).toMatchObject({
      workspaceId: f.workspaceId,
      visibility: 'private',
      accessRole: 'owner',
      bindingStatus: { state: 'ready', chatOnly: true },
      currentVersion: {
        number: 1,
        configuration: preview.configuration,
        author: { id: f.actorId, displayName: 'Copy actor' },
        rationale: 'Copied configuration',
      },
    });
    expect(await bots().get(f.actorId, f.workspaceId, copied.id)).toEqual(copied);
    await expect(bots().get(f.ownerId, f.workspaceId, copied.id)).rejects.toBeInstanceOf(
      BotAccessError,
    );
    const after = await snapshot(f.workspaceId);
    expect(after.bots.filter((row) => row.id === f.bot.id)).toEqual(before.bots);
    expect(after.versions.filter((row) => row.bot_id === f.bot.id)).toEqual(before.versions);
    expect(after.acl.filter((row) => row.bot_id === f.bot.id)).toEqual(before.acl);
    expect(after.bots.filter((row) => row.id === copied.id)).toEqual([
      expect.objectContaining({
        current_version_id: copied.currentVersion!.id,
        visibility: 'private',
        created_by_user_id: f.actorId,
      }),
    ]);
    expect(after.versions.filter((row) => row.bot_id === copied.id)).toEqual([
      expect.objectContaining({
        id: copied.currentVersion!.id,
        version: 1,
        configuration: preview.configuration,
      }),
    ]);
    expect(after.acl.filter((row) => row.bot_id === copied.id)).toEqual([
      expect.objectContaining({ user_id: f.actorId, role: 'owner' }),
    ]);
    const events = after.audits.filter((row) => row.metadata.botId === copied.id);
    expect(events).toEqual([
      expect.objectContaining({
        event_type: 'bot.copied',
        actor_user_id: f.actorId,
        metadata: {
          workspaceId: f.workspaceId,
          botId: copied.id,
          versionId: copied.currentVersion!.id,
          version: 1,
          sourceBotId: f.bot.id,
          sourceVersionId: edited.id,
        },
      }),
    ]);
    expect(after.audits.filter((row) => row.metadata.botId !== copied.id)).toEqual(before.audits);
    expect(after.objects).toEqual([]);
    expect(after.references).toEqual([]);
    expect(JSON.stringify([preview, copied, after.versions, events])).not.toMatch(
      /native-copy-provider-secret|native-copy-header-secret|apiKey|authorization|sealed_credentials|ciphertext|storageKey/iu,
    );
  });

  it('requires explicit inspection even for a workspace administrator who can discover the source', async () => {
    const f = await fixture();
    await acl().changeVisibility(f.ownerId, f.workspaceId, f.bot.id, { visibility: 'workspace' });
    const before = await snapshot(f.workspaceId);
    const access = f.copy.access(f.administratorId, f.workspaceId, f.bot.id);
    expect((await bots().list(f.administratorId, f.workspaceId)).map((bot) => bot.id)).toContain(
      f.bot.id,
    );
    await expect(f.copy.preview(access)).rejects.toBeInstanceOf(BotAccessError);
    await expect(
      f.copy.confirm(access, { expectedCurrentVersionId: f.versionId }),
    ).rejects.toBeInstanceOf(BotAccessError);
    expect(await snapshot(f.workspaceId)).toEqual(before);
  });

  it('requires independent model rights and accepts only a usable actor replacement', async () => {
    const f = await fixture('personal');
    const before = await snapshot(f.workspaceId);
    const preview = await f.copy.preview(f.access);
    expect(preview.bindingStatus).toEqual({ state: 'unavailable', reason: 'not-accessible' });
    expect(await snapshot(f.workspaceId)).toEqual(before);
    await expect(
      f.copy.confirm(f.access, { expectedCurrentVersionId: f.versionId }),
    ).rejects.toMatchObject(new BotModelError('not-accessible'));
    expect(await snapshot(f.workspaceId)).toEqual(before);
    const model = await providers().save(f.actorId, providerInput);
    const replacement = {
      scope: { kind: 'personal', id: f.actorId },
      connectionId: model.id,
      modelId: model.modelId,
    };
    const copied = await f.copy.confirm(f.access, {
      expectedCurrentVersionId: f.versionId,
      modelBinding: replacement,
    });
    expect(copied.currentVersion!.configuration).toEqual({
      ...preview.configuration,
      modelBinding: replacement,
    });
    expect(copied.bindingStatus).toEqual({ state: 'ready', chatOnly: true });
    expect(
      (await snapshot(f.workspaceId)).versions.filter((row) => row.bot_id === f.bot.id),
    ).toEqual(before.versions);
  });

  it('rolls back the new identity, version, ACL, avatar reference and audit on mandatory audit failure without orphan files', async () => {
    const f = await fixture();
    const uploaded = await f.avatars.upload(f.ownerAccess, f.versionId, png, 'image/png');
    const before = await snapshot(f.workspaceId);
    const files = await readdir(join(f.directory, f.workspaceId));
    const bytes = await f.avatars.read(f.ownerAccess, uploaded.id);
    await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
    try {
      await expect(
        f.copy.confirm(f.access, { expectedCurrentVersionId: uploaded.id }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
    }
    expect(await snapshot(f.workspaceId)).toEqual(before);
    expect(await readdir(join(f.directory, f.workspaceId))).toEqual(files);
    expect(await f.avatars.read(f.access, uploaded.id)).toEqual(bytes);
    expect(await f.avatars.cleanup()).toEqual({ retained: 0, deleted: 0, retried: 0 });
  });

  it('rejects a queued confirm after a source edit commits and previews the newly current version', async () => {
    const f = await fixture(),
      writer = observedPool(),
      copier = observedPool(),
      blocker = await admin.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const edited = new BotVersionService(writer.pool, f.avatars).edit(f.ownerAccess, {
        expectedCurrentVersionId: f.versionId,
        changes: { name: 'Latest source configuration' },
      });
      pending.push(edited);
      void edited.catch(() => undefined);
      const writerPid = await waitForBlocked(writer.name, pid);
      const copy = new BotCopyService(copier.pool).confirm(f.access, {
        expectedCurrentVersionId: f.versionId,
      });
      const rejected = expect(copy).rejects.toBeInstanceOf(BotVersionConflictError);
      pending.push(copy, rejected);
      void rejected.catch(() => undefined);
      await waitForBlocked(copier.name, writerPid);
      await blocker.query('COMMIT');
      const version = await edited;
      await rejected;
      const beforePreview = await snapshot(f.workspaceId);
      expect(beforePreview.bots).toHaveLength(1);
      expect(beforePreview.versions).toHaveLength(2);
      expect(beforePreview.audits.filter((row) => row.event_type === 'bot.copied')).toEqual([]);
      expect(await f.copy.preview(f.access)).toMatchObject({
        sourceVersionId: version.id,
        sourceVersionNumber: 2,
        configuration: { name: 'Latest source configuration' },
      });
      expect(await snapshot(f.workspaceId)).toEqual(beforePreview);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(pending);
      await Promise.all([writer.pool.end(), copier.pool.end()]);
    }
  }, 20000);

  it.each(['preview', 'confirm'] as const)(
    'rechecks explicit Bot and workspace access when %s waits behind a committed revocation',
    async (operation) => {
      for (const scope of ['bot-acl', 'workspace'] as const) {
        const f = await fixture(),
          revoker = observedPool(),
          copier = observedPool(),
          blocker = await admin.connect();
        const pending: Promise<unknown>[] = [];
        const before = await snapshot(f.workspaceId);
        try {
          await blocker.query('BEGIN');
          await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
          const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const revoked =
            scope === 'bot-acl'
              ? acl(revoker.pool).revoke(f.ownerId, f.workspaceId, f.bot.id, f.actorId)
              : new WorkspaceMemberService(
                  new PostgresWorkspaceMemberRepository(revoker.pool),
                ).remove(f.ownerId, f.workspaceId, f.actorId);
          pending.push(revoked);
          void revoked.catch(() => undefined);
          const revokerPid = await waitForBlocked(revoker.name, pid);
          const service = new BotCopyService(copier.pool);
          const request =
            operation === 'preview'
              ? service.preview(f.access)
              : service.confirm(f.access, { expectedCurrentVersionId: f.versionId });
          const rejected = expect(request).rejects.toBeInstanceOf(BotAccessError);
          pending.push(request, rejected);
          void rejected.catch(() => undefined);
          await waitForBlocked(copier.name, revokerPid);
          await blocker.query('COMMIT');
          await revoked;
          await rejected;
          const after = await snapshot(f.workspaceId);
          expect(after.bots).toEqual(before.bots);
          expect(after.versions).toEqual(before.versions);
          expect(after.references).toEqual(before.references);
          expect(after.objects).toEqual(before.objects);
          expect(after.audits.filter((row) => row.event_type === 'bot.copied')).toEqual([]);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await Promise.allSettled(pending);
          await Promise.all([revoker.pool.end(), copier.pool.end()]);
        }
      }
    },
    20000,
  );

  it.each(['bot-acl', 'workspace'] as const)(
    'commits an admitted copy before a queued %s revocation can remove source authority',
    async (scope) => {
      const f = await fixture(),
        copier = observedPool(),
        revoker = observedPool(),
        blocker = await admin.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const copied = new BotCopyService(copier.pool).confirm(f.access, {
          expectedCurrentVersionId: f.versionId,
        });
        pending.push(copied);
        void copied.catch(() => undefined);
        const copierPid = await waitForBlocked(copier.name, pid);
        const revoked =
          scope === 'bot-acl'
            ? acl(revoker.pool).revoke(f.ownerId, f.workspaceId, f.bot.id, f.actorId)
            : new WorkspaceMemberService(
                new PostgresWorkspaceMemberRepository(revoker.pool),
              ).remove(f.ownerId, f.workspaceId, f.actorId);
        pending.push(revoked);
        void revoked.catch(() => undefined);
        await waitForBlocked(revoker.name, copierPid);
        // Uncommitted identity, version, owner ACL and provenance are invisible
        // to another real connection while the mandatory audit insert waits.
        expect(
          (await admin.query('SELECT id FROM bots WHERE workspace_id=$1', [f.workspaceId])).rows,
        ).toEqual([{ id: f.bot.id }]);
        await blocker.query('COMMIT');
        const bot = await copied;
        await revoked;
        const state = await snapshot(f.workspaceId);
        expect(state.bots).toHaveLength(2);
        expect(state.versions.filter((row) => row.bot_id === bot.id)).toEqual([
          expect.objectContaining({ id: bot.currentVersion!.id, version: 1 }),
        ]);
        expect(state.acl.filter((row) => row.bot_id === bot.id)).toEqual([
          expect.objectContaining({ user_id: f.actorId, role: 'owner' }),
        ]);
        expect(state.audits.filter((row) => row.event_type === 'bot.copied')).toEqual([
          expect.objectContaining({
            metadata: expect.objectContaining({ botId: bot.id, sourceBotId: f.bot.id }),
          }),
        ]);
        await expect(f.copy.preview(f.access)).rejects.toBeInstanceOf(BotAccessError);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all([copier.pool.end(), revoker.pool.end()]);
      }
    },
    20000,
  );

  it.each(['disabled', 'binding-changed', 'capability-unavailable', 'not-accessible'] as const)(
    'revalidates %s replacement model state after the provider scope lock wait',
    async (reason) => {
      const f = await fixture(),
        copier = observedPool(),
        blocker = await runtime.connect();
      const model = await providers().save(f.actorId, providerInput);
      const before = await snapshot(f.workspaceId);
      const now = vi.fn(() => new Date());
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await authorizeProviderScope(blocker, personalAccess(f.actorId), 'manage');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = new BotCopyService(copier.pool, now).confirm(f.access, {
          expectedCurrentVersionId: f.versionId,
          modelBinding: {
            scope: { kind: 'personal', id: f.actorId },
            connectionId: model.id,
            modelId: model.modelId,
          },
        });
        const rejected = expect(pending).rejects.toMatchObject(new BotModelError(reason));
        void rejected.catch(() => undefined);
        await waitForBlocked(copier.name, pid);
        expect(now).not.toHaveBeenCalled();
        if (reason === 'disabled')
          await blocker.query(
            "UPDATE personal_model_connections SET metadata=jsonb_set(metadata,'{enabled}','false'::jsonb) WHERE id=$1",
            [model.id],
          );
        else if (reason === 'binding-changed')
          await blocker.query(
            "UPDATE personal_model_connections SET metadata=jsonb_set(metadata,'{modelId}',to_jsonb('changed-model'::text)) WHERE id=$1",
            [model.id],
          );
        else if (reason === 'capability-unavailable')
          await blocker.query(
            "UPDATE personal_model_connections SET policy='{}'::jsonb WHERE id=$1",
            [model.id],
          );
        else await blocker.query('DELETE FROM personal_model_connections WHERE id=$1', [model.id]);
        await blocker.query('COMMIT');
        await rejected;
        expect(await snapshot(f.workspaceId)).toEqual(before);
        expect(now).not.toHaveBeenCalled();
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => undefined);
        await copier.pool.end();
      }
    },
    20000,
  );

  it('publishes a retained avatar reference before queued cleanup and creates no second object or file', async () => {
    const f = await fixture(),
      copier = observedPool(),
      cleaner = observedPool(),
      blocker = await admin.connect();
    const uploaded = await f.avatars.upload(f.ownerAccess, f.versionId, png, 'image/png');
    const objectId = uploaded.configuration.avatarObjectId!;
    const bytes = await f.avatars.read(f.access, uploaded.id);
    // A live retained object can be due for reconciliation. Cleanup must inspect
    // durable references under the same workspace -> object lock order as copy.
    await runtime.query('UPDATE avatar_objects SET cleanup_after=NOW() WHERE id=$1', [objectId]);
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM avatar_objects WHERE id=$1 FOR UPDATE', [objectId]);
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const copy = new BotCopyService(copier.pool).confirm(f.access, {
        expectedCurrentVersionId: uploaded.id,
      });
      pending.push(copy);
      void copy.catch(() => undefined);
      const copierPid = await waitForBlocked(copier.name, pid);
      const cleanup = new BotAvatarService(cleaner.pool, f.store).cleanup();
      pending.push(cleanup);
      void cleanup.catch(() => undefined);
      await waitForBlocked(cleaner.name, copierPid);
      await blocker.query('COMMIT');
      const copied = await copy;
      expect(await cleanup).toEqual({ retained: 1, deleted: 0, retried: 0 });
      expect(copied.avatarVersionId).toBe(copied.currentVersion!.id);
      expect(copied.currentVersion!.configuration.avatarObjectId).toBe(objectId);
      const copiedAccess = f.copy.access(f.actorId, f.workspaceId, copied.id);
      expect(await f.avatars.read(copiedAccess, copied.currentVersion!.id)).toEqual(bytes);
      expect(await f.avatars.read(f.access, uploaded.id)).toEqual(bytes);
      const state = await snapshot(f.workspaceId);
      expect(state.references).toHaveLength(2);
      expect(state.references).toEqual(
        expect.arrayContaining([
          { version_id: uploaded.id, object_id: objectId },
          { version_id: copied.currentVersion!.id, object_id: objectId },
        ]),
      );
      expect(state.objects).toEqual([
        expect.objectContaining({ id: objectId, bot_id: f.bot.id, state: 'live' }),
      ]);
      expect(await readdir(join(f.directory, f.workspaceId))).toEqual([objectId]);
      await f.avatars.remove(f.ownerAccess, uploaded.id);
      expect(await f.avatars.cleanup()).toEqual({ retained: 1, deleted: 0, retried: 0 });
      expect(await f.avatars.read(copiedAccess, copied.currentVersion!.id)).toEqual(bytes);
      expect(await f.avatars.read(f.access, uploaded.id)).toEqual(bytes);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(pending);
      await Promise.all([copier.pool.end(), cleaner.pool.end()]);
    }
  }, 20000);

  it.each(['preview', 'confirm'] as const)(
    'rechecks live avatar state after a queued %s obtains its object row lock',
    async (operation) => {
      const f = await fixture(),
        copier = observedPool(),
        blocker = await runtime.connect();
      const uploaded = await f.avatars.upload(f.ownerAccess, f.versionId, png, 'image/png');
      const objectId = uploaded.configuration.avatarObjectId!;
      const before = await snapshot(f.workspaceId);
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM avatar_objects WHERE id=$1 FOR UPDATE', [objectId]);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const service = new BotCopyService(copier.pool);
        pending =
          operation === 'preview'
            ? service.preview(f.access)
            : service.confirm(f.access, { expectedCurrentVersionId: uploaded.id });
        const rejected = expect(pending).rejects.toBeInstanceOf(BotAvatarUnavailableError);
        void rejected.catch(() => undefined);
        await waitForBlocked(copier.name, pid);
        // Explicit storage-state fault injection, not a claim that normal cleanup
        // can delete an object whose immutable source reference still exists.
        await blocker.query("UPDATE avatar_objects SET state='deleting' WHERE id=$1", [objectId]);
        await blocker.query('COMMIT');
        await rejected;
        const after = await snapshot(f.workspaceId);
        expect(after.bots).toEqual(before.bots);
        expect(after.versions).toEqual(before.versions);
        expect(after.acl).toEqual(before.acl);
        expect(after.references).toEqual(before.references);
        expect(after.audits).toEqual(before.audits);
        expect(after.objects).toEqual(before.objects.map((row) => ({ ...row, state: 'deleting' })));
        expect(await readdir(join(f.directory, f.workspaceId))).toEqual([objectId]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => undefined);
        await runtime.query("UPDATE avatar_objects SET state='live' WHERE id=$1", [objectId]);
        await copier.pool.end();
      }
    },
    20000,
  );
  it('rejects a queued copy after source deletion commits without changing the source configuration version', async () => {
    const f = await fixture(),
      writer = observedPool(),
      copier = observedPool(),
      blocker = await admin.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE');
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const deletion = new BotLifecycleService(writer.pool).softDelete(
        f.ownerId,
        f.workspaceId,
        f.bot.id,
      );
      pending.push(deletion);
      void deletion.catch(() => undefined);
      const writerPid = await waitForBlocked(writer.name, pid);
      const copy = new BotCopyService(copier.pool).confirm(f.access, {
        expectedCurrentVersionId: f.versionId,
      });
      const rejected = expect(copy).rejects.toBeInstanceOf(BotAccessError);
      pending.push(copy, rejected);
      void rejected.catch(() => undefined);
      await waitForBlocked(copier.name, writerPid);
      await blocker.query('COMMIT');
      await deletion;
      await rejected;
      const state = await snapshot(f.workspaceId);
      expect(state.bots).toEqual([
        expect.objectContaining({
          id: f.bot.id,
          current_version_id: f.versionId,
          lifecycle_state: 'deleted',
        }),
      ]);
      expect(state.versions).toHaveLength(1);
      expect(state.audits.filter((row) => row.event_type === 'bot.copied')).toEqual([]);
      await expect(f.copy.preview(f.ownerAccess)).rejects.toBeInstanceOf(BotAccessError);
      await new BotLifecycleService(runtime).undoDelete(f.ownerId, f.workspaceId, f.bot.id);
      const recoveredCopy = await f.copy.confirm(f.access, {
        expectedCurrentVersionId: f.versionId,
      });
      expect(recoveredCopy.lifecycleState).toBe('active');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(pending);
      await Promise.all([writer.pool.end(), copier.pool.end()]);
    }
  }, 20000);
});

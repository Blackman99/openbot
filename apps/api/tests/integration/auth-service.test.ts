import { createHash } from 'node:crypto';

import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { InstanceAlreadyClaimedError } from '../../src/auth/repository.js';
import { InvalidCredentialsError, LocalAuthService } from '../../src/auth/service.js';
import { migrateDatabase } from '../../src/database/migrations.js';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];

describe('local authentication service', () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('atomically claims an owner, default workspace, owner membership, session, and safe audits', async () => {
    const memoryDatabase = newDb({ noAstCoverageCheck: true });
    const adapter = memoryDatabase.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    await migrateDatabase(pool, { installPostgresGuards: false });

    const rawToken = Buffer.alloc(32, 7).toString('base64url');
    let nextId = 0;
    const service = new LocalAuthService(new PostgresAuthRepository(pool), {
      clock: () => new Date('2030-01-02T03:04:05.000Z'),
      generateId: () => ids[nextId++] ?? '00000000-0000-4000-8000-000000000099',
      generateSessionToken: () => rawToken,
    });

    const result = await service.setup({
      displayName: ' Ada Lovelace ',
      email: ' Ada@Example.com ',
      password: 'correct horse battery staple',
    });

    expect(result).toMatchObject({
      expiresAt: new Date('2030-02-01T03:04:05.000Z'),
      sessionToken: rawToken,
      user: {
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        id: ids[0],
      },
      workspace: { id: ids[1], name: 'My Workspace' },
    });

    const users = await pool.query('SELECT * FROM users');
    expect(users.rows).toMatchObject([
      {
        display_name: 'Ada Lovelace',
        email: 'ada@example.com',
        id: ids[0],
        is_instance_admin: true,
        normalized_email: 'ada@example.com',
      },
    ]);
    const credentials = await pool.query('SELECT * FROM local_credentials');
    expect(credentials.rows[0]?.password_hash).toMatch(/^\$argon2id\$/u);
    expect(credentials.rows[0]?.password_hash).not.toContain('correct horse battery staple');
    await expect(pool.query('SELECT * FROM instance_claims')).resolves.toMatchObject({
      rows: [{ owner_user_id: ids[0], singleton_key: true }],
    });
    await expect(pool.query('SELECT * FROM workspaces')).resolves.toMatchObject({
      rows: [{ id: ids[1], name: 'My Workspace' }],
    });
    await expect(pool.query('SELECT * FROM workspace_memberships')).resolves.toMatchObject({
      rows: [{ role: 'owner', user_id: ids[0], workspace_id: ids[1] }],
    });

    const tokenDigest = createHash('sha256').update(rawToken).digest('hex');
    await expect(pool.query('SELECT * FROM sessions')).resolves.toMatchObject({
      rows: [{ token_digest: tokenDigest, user_id: ids[0], revoked_at: null }],
    });

    const audits = await pool.query(
      'SELECT event_type, actor_user_id, metadata FROM audit_events ORDER BY occurred_at, event_type',
    );
    expect(audits.rows).toEqual([
      { actor_user_id: ids[0], event_type: 'auth.signed_in', metadata: { method: 'local' } },
      {
        actor_user_id: ids[0],
        event_type: 'instance.claimed',
        metadata: { workspaceId: ids[1] },
      },
    ]);
    expect(JSON.stringify(audits.rows)).not.toMatch(
      /correct horse|argon2|cookie|secret|session|token/iu,
    );
    expect(JSON.stringify([...users.rows, ...credentials.rows])).not.toContain(rawToken);
  });

  it('rejects an already claimed instance before performing another expensive password hash', async () => {
    const memoryDatabase = newDb({ noAstCoverageCheck: true });
    const adapter = memoryDatabase.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    await migrateDatabase(pool, { installPostgresGuards: false });

    let nextId = 0;
    const hashPassword = vi.fn(async () => '$argon2id$test-only');
    const service = new LocalAuthService(new PostgresAuthRepository(pool), {
      generateId: () => ids[nextId++] ?? '00000000-0000-4000-8000-000000000099',
      generateSessionToken: () => Buffer.alloc(32, 7).toString('base64url'),
      hashPassword,
    });
    await service.setup({
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });

    await expect(
      service.setup({
        displayName: 'Second Owner',
        email: 'second@example.com',
        password: 'another secure password',
      }),
    ).rejects.toBeInstanceOf(InstanceAlreadyClaimedError);
    expect(hashPassword).toHaveBeenCalledOnce();
  });

  it('signs the local owner in with a fresh digest-only session and rejects invalid credentials', async () => {
    const memoryDatabase = newDb({ noAstCoverageCheck: true });
    const adapter = memoryDatabase.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    await migrateDatabase(pool, { installPostgresGuards: false });

    const tokens = [
      Buffer.alloc(32, 1).toString('base64url'),
      Buffer.alloc(32, 2).toString('base64url'),
    ];
    let nextId = 0;
    let nextToken = 0;
    const service = new LocalAuthService(new PostgresAuthRepository(pool), {
      clock: () => new Date('2030-01-02T03:04:05.000Z'),
      generateId: () => ids[nextId++] ?? '00000000-0000-4000-8000-000000000099',
      generateSessionToken: () => tokens[nextToken++] ?? Buffer.alloc(32, 3).toString('base64url'),
    });
    await service.setup({
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });

    const signedIn = await service.signIn({
      email: ' ADA@example.com ',
      password: 'correct horse battery staple',
    });

    expect(signedIn).toMatchObject({
      sessionToken: tokens[1],
      user: { email: 'ada@example.com', id: ids[0] },
      workspace: { id: ids[1], name: 'My Workspace' },
    });
    const sessions = await pool.query('SELECT token_digest FROM sessions ORDER BY token_digest');
    expect(sessions.rows).toHaveLength(2);
    expect(JSON.stringify(sessions.rows)).not.toContain(tokens[0]);
    expect(JSON.stringify(sessions.rows)).not.toContain(tokens[1]);

    await expect(
      service.signIn({ email: 'ada@example.com', password: 'wrong password value' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(
      service.signIn({ email: 'missing@example.com', password: 'wrong password value' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    const audits = await pool.query(
      "SELECT metadata FROM audit_events WHERE event_type = 'auth.signed_in'",
    );
    expect(audits.rows).toEqual([
      { metadata: { method: 'local' } },
      { metadata: { method: 'local' } },
    ]);
  });

  it('authenticates only a known, unexpired, unrevoked digest-backed session', async () => {
    const memoryDatabase = newDb({ noAstCoverageCheck: true });
    const adapter = memoryDatabase.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    await migrateDatabase(pool, { installPostgresGuards: false });

    let now = new Date('2030-01-02T03:04:05.000Z');
    let nextId = 0;
    const rawToken = Buffer.alloc(32, 9).toString('base64url');
    const service = new LocalAuthService(new PostgresAuthRepository(pool), {
      clock: () => now,
      generateId: () => ids[nextId++] ?? '00000000-0000-4000-8000-000000000099',
      generateSessionToken: () => rawToken,
      hashPassword: async () => '$argon2id$test-only',
    });
    await service.setup({
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });

    await expect(service.getSession(rawToken)).resolves.toMatchObject({
      user: { email: 'ada@example.com', id: ids[0] },
      workspace: { id: ids[1], name: 'My Workspace' },
    });
    await expect(
      service.getSession(Buffer.alloc(32, 8).toString('base64url')),
    ).resolves.toBeUndefined();

    now = new Date('2030-02-01T03:04:05.001Z');
    await expect(service.getSession(rawToken)).resolves.toBeUndefined();
  });

  it('atomically revokes a session and appends exactly one safe sign-out audit event', async () => {
    const memoryDatabase = newDb({ noAstCoverageCheck: true });
    const adapter = memoryDatabase.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    await migrateDatabase(pool, { installPostgresGuards: false });

    let nextId = 0;
    const rawToken = Buffer.alloc(32, 4).toString('base64url');
    const service = new LocalAuthService(new PostgresAuthRepository(pool), {
      clock: () => new Date('2030-01-02T03:04:05.000Z'),
      generateId: () => ids[nextId++] ?? '00000000-0000-4000-8000-000000000099',
      generateSessionToken: () => rawToken,
      hashPassword: async () => '$argon2id$test-only',
    });
    await service.setup({
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });

    await expect(service.signOut(rawToken)).resolves.toBe(true);
    await expect(service.getSession(rawToken)).resolves.toBeUndefined();
    await expect(service.signOut(rawToken)).resolves.toBe(false);

    const audits = await pool.query(
      "SELECT actor_user_id, metadata FROM audit_events WHERE event_type = 'auth.signed_out'",
    );
    expect(audits.rows).toEqual([{ actor_user_id: ids[0], metadata: {} }]);
    expect(JSON.stringify(audits.rows)).not.toMatch(/cookie|secret|session|token/iu);
  });
  it('keeps sessions and password sign-in valid after losing the final workspace membership', async () => {
    const memoryDatabase = newDb({ noAstCoverageCheck: true });
    const pool = new (memoryDatabase.adapters.createPg().Pool)();
    pools.push(pool);
    await migrateDatabase(pool, { installPostgresGuards: false });
    const auth = new LocalAuthService(new PostgresAuthRepository(pool), {
      hashPassword: async () => '$argon2id$test-only',
      verifyPassword: async () => true,
    });
    const owner = await auth.setup({
      displayName: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [owner.user.id]);
    await expect(auth.getSession(owner.sessionToken)).resolves.toEqual({
      user: owner.user,
      workspace: null,
    });
    await expect(
      auth.signIn({ email: 'ada@example.com', password: 'correct horse battery staple' }),
    ).resolves.toMatchObject({ user: owner.user, workspace: null });
  });
});

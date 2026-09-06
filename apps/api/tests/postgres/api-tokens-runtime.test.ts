import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiTokenAuthenticationError,
  ApiTokenService,
  digestApiToken,
} from '../../src/api-tokens/service.js';
import { PostgresApiTokenRepository } from '../../src/api-tokens/postgres-repository.js';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
postgresDescribe('real PostgreSQL scoped API token invariants', () => {
  const schema = `api_tokens_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const now = new Date('2030-01-01T00:00:00.000Z');
  const repository = new PostgresApiTokenRepository(pool);
  const tokens = new ApiTokenService(repository, () => now);
  const members = new PostgresWorkspaceMemberRepository(pool);
  const input = {
    name: 'Runtime automation',
    scopes: ['me:read'],
    expiresAt: '2030-02-01T00:00:00.000Z',
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateDatabase(pool);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  async function fixture() {
    const owner = randomUUID(),
      creator = randomUUID(),
      workspace = randomUUID();
    for (const id of [owner, creator])
      await pool.query(
        'INSERT INTO users (id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$3,$4)',
        [id, `${id}@example.com`, 'Runtime user', now],
      );
    await pool.query(
      "INSERT INTO workspaces (id,name,created_at) VALUES ($1,'Runtime workspace',$2)",
      [workspace, now],
    );
    for (const [id, role] of [
      [owner, 'owner'],
      [creator, 'member'],
    ])
      await pool.query(
        'INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,$3,$4)',
        [workspace, id, role, now],
      );
    return { owner, creator, workspace };
  }
  it('rolls creation, last-use, revocation and member removal back when the security audit fails', async () => {
    const { owner, creator, workspace } = await fixture();
    const created = await tokens.create(creator, workspace, input);
    const auditId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM audit_events WHERE event_type = 'api_token.created' AND actor_user_id = $1",
        [creator],
      )
    ).rows[0]!.id;
    const failedTokenId = randomUUID();
    await expect(
      repository.create(
        {
          token: { ...created.token, id: failedTokenId },
          tokenDigest: 'f'.repeat(64),
          auditId,
        },
        () => now,
      ),
    ).rejects.toThrow();
    expect(
      (await pool.query('SELECT id FROM api_tokens WHERE id = $1', [failedTokenId])).rows,
    ).toEqual([]);
    await expect(
      repository.authorize(
        {
          tokenDigest: digestApiToken(created.secret),
          requiredScope: 'me:read',
          auditId,
        },
        () => now,
      ),
    ).rejects.toThrow();
    expect(
      (await pool.query('SELECT last_used_at FROM api_tokens WHERE id = $1', [created.token.id]))
        .rows,
    ).toEqual([{ last_used_at: null }]);
    await expect(
      repository.revoke({
        tokenId: created.token.id,
        workspaceId: workspace,
        actorUserId: creator,
        occurredAt: now,
        auditId,
      }),
    ).rejects.toThrow();
    await expect(
      members.remove({
        actorUserId: owner,
        targetUserId: creator,
        workspaceId: workspace,
        occurredAt: now,
        auditId,
      }),
    ).rejects.toThrow();
    expect(
      (await pool.query('SELECT revoked_at FROM api_tokens WHERE id = $1', [created.token.id]))
        .rows,
    ).toEqual([{ revoked_at: null }]);
    expect(
      (
        await pool.query(
          'SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
          [workspace, creator],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT id FROM audit_events WHERE event_type = 'api_token.revoked' AND metadata->>'tokenId' = $1",
          [created.token.id],
        )
      ).rows,
    ).toEqual([]);
    await expect(tokens.authorize(created.secret, 'me:read')).resolves.toMatchObject({
      user: { id: creator },
      workspace: { id: workspace, role: 'member' },
    });
    expect(JSON.stringify((await pool.query('SELECT * FROM api_tokens')).rows)).not.toContain(
      created.secret,
    );
    expect(JSON.stringify((await pool.query('SELECT * FROM audit_events')).rows)).not.toContain(
      created.secret,
    );
  });
  it('serializes token creation against removal and prevents revival on same-timestamp rejoining', async () => {
    const { owner, creator, workspace } = await fixture();
    const old = await tokens.create(creator, workspace, input);
    const [creation, removal] = await Promise.allSettled([
      tokens.create(creator, workspace, input),
      members.remove({
        actorUserId: owner,
        targetUserId: creator,
        workspaceId: workspace,
        occurredAt: now,
        auditId: randomUUID(),
      }),
    ]);
    expect(removal.status).toBe('fulfilled');
    await expect(tokens.authorize(old.secret, 'me:read')).rejects.toBeInstanceOf(
      ApiTokenAuthenticationError,
    );
    if (creation.status === 'fulfilled')
      await expect(tokens.authorize(creation.value.secret, 'me:read')).rejects.toBeInstanceOf(
        ApiTokenAuthenticationError,
      );
    expect(
      (
        await pool.query(
          'SELECT id FROM api_tokens WHERE workspace_id = $1 AND revoked_at IS NULL',
          [workspace],
        )
      ).rows,
    ).toEqual([]);
    await pool.query(
      "INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,'member',$3)",
      [workspace, creator, now],
    );
    await expect(tokens.authorize(old.secret, 'me:read')).rejects.toBeInstanceOf(
      ApiTokenAuthenticationError,
    );
    const fresh = await tokens.create(creator, workspace, input);
    await expect(tokens.authorize(fresh.secret, 'me:read')).resolves.toMatchObject({
      user: { id: creator },
    });
  });
});

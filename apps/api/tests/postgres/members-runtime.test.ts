import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresWorkspaceMemberRepository } from '../../src/members/postgres-member-repository.js';
import {
  LastWorkspaceOwnerError,
  WorkspaceMemberAccessError,
  WorkspaceMemberService,
} from '../../src/members/service.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe('real PostgreSQL workspace membership invariants', () => {
  const schema = `members_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const repository = new PostgresWorkspaceMemberRepository(pool);
  const members = new WorkspaceMemberService(repository);

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateDatabase(pool);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  async function twoOwners() {
    const first = randomUUID();
    const second = randomUUID();
    for (const id of [first, second])
      await pool.query(
        'INSERT INTO users (id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$3,NOW())',
        [id, `${id}@example.com`, 'Member'],
      );
    const workspace = await new WorkspaceService(new PostgresWorkspaceRepository(pool)).create(
      first,
      { name: 'Concurrent owners' },
    );
    await pool.query(
      "INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,'owner',NOW())",
      [workspace.id, second],
    );
    return { first, second, workspace };
  }

  it('serializes simultaneous owner demotions so exactly one owner remains', async () => {
    const { first, second, workspace } = await twoOwners();
    const outcomes = await Promise.allSettled(
      [first, second].map((userId) =>
        members.changeRole(userId, workspace.id, userId, { role: 'member' }),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(
      rejected?.status === 'rejected' && rejected.reason instanceof LastWorkspaceOwnerError,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner'",
          [workspace.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM audit_events WHERE event_type = 'workspace.member_role_changed' AND metadata->>'workspaceId' = $1",
          [workspace.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });

  it('serializes owners removing each other and rechecks the waiting actor membership', async () => {
    const { first, second, workspace } = await twoOwners();
    const outcomes = await Promise.allSettled([
      members.remove(first, workspace.id, second),
      members.remove(second, workspace.id, first),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(
      rejected?.status === 'rejected' && rejected.reason instanceof WorkspaceMemberAccessError,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner'",
          [workspace.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (await pool.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [[first, second]])).rows,
    ).toHaveLength(2);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM audit_events WHERE event_type = 'workspace.member_removed' AND metadata->>'workspaceId' = $1",
          [workspace.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });

  it('rolls back role changes and removals when their mandatory audit insert fails', async () => {
    const { first, second, workspace } = await twoOwners();
    const existing = (await pool.query<{ id: string }>('SELECT id FROM audit_events LIMIT 1'))
      .rows[0]!;
    const record = {
      actorUserId: first,
      workspaceId: workspace.id,
      targetUserId: second,
      occurredAt: new Date(),
      auditId: existing.id,
    };
    await expect(repository.changeRole({ ...record, role: 'member' })).rejects.toThrow();
    await expect(repository.remove(record)).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner'",
          [workspace.id],
        )
      ).rows,
    ).toHaveLength(2);
    const listed = await members.list(first, workspace.id);
    expect(listed.map((member) => member.user.id).sort()).toEqual([first, second].sort());
  });
});

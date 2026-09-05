import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { GroupAccessError, GroupService, LastGroupOwnerError } from '../../src/groups/service.js';
import { PostgresWorkspaceRepository } from '../../src/workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
postgresDescribe('real PostgreSQL group authority and atomic audits', () => {
  const schema = `groups_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const repository = new PostgresGroupRepository(pool);
  const groups = new GroupService(repository);
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
    const first = randomUUID(),
      second = randomUUID(),
      third = randomUUID();
    for (const id of [first, second, third])
      await pool.query(
        'INSERT INTO users (id,email,normalized_email,display_name,created_at) VALUES ($1,$2,$2,$3,NOW())',
        [id, `${id}@example.com`, 'Group member'],
      );
    const workspace = await new WorkspaceService(new PostgresWorkspaceRepository(pool)).create(
      first,
      { name: 'Group concurrency' },
    );
    for (const id of [second, third])
      await pool.query(
        "INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at) VALUES ($1,$2,'member',NOW())",
        [workspace.id, id],
      );
    const group = await groups.create(first, workspace.id, { name: 'Concurrent owners' });
    await groups.addMember(first, workspace.id, group.id, { userId: second, role: 'owner' });
    return { first, second, third, workspace, group };
  }
  it('serializes concurrent self-demotions and keeps one eligible group owner', async () => {
    const { first, second, workspace, group } = await twoOwners();
    const outcomes = await Promise.allSettled(
      [first, second].map((actor) =>
        groups.changeRole(actor, workspace.id, group.id, actor, { role: 'member' }),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason instanceof LastGroupOwnerError).toBe(
      true,
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM group_memberships gm INNER JOIN workspace_memberships wm ON wm.user_id=gm.user_id AND wm.workspace_id=$1 WHERE gm.group_id=$2 AND gm.role='owner'",
          [workspace.id, group.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE event_type='group.member_role_changed' AND metadata->>'groupId'=$1",
          [group.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it('serializes owners removing each other and rechecks the waiting actor group grant', async () => {
    const { first, second, workspace, group } = await twoOwners();
    const outcomes = await Promise.allSettled([
      groups.removeMember(first, workspace.id, group.id, second),
      groups.removeMember(second, workspace.id, group.id, first),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason instanceof GroupAccessError).toBe(
      true,
    );
    const remaining = (
      await pool.query<{ user_id: string }>(
        "SELECT user_id FROM group_memberships WHERE group_id=$1 AND role='owner'",
        [group.id],
      )
    ).rows;
    expect(remaining).toHaveLength(1);
    const removed = remaining[0]!.user_id === first ? second : first;
    await expect(groups.authorizeContent(removed, workspace.id, group.id)).rejects.toBeInstanceOf(
      GroupAccessError,
    );
    await expect(
      groups.authorizeSubscription(removed, workspace.id, group.id),
    ).rejects.toBeInstanceOf(GroupAccessError);
    expect(
      (await pool.query('SELECT id FROM users WHERE id=ANY($1::uuid[])', [[first, second]])).rows,
    ).toHaveLength(2);
    expect(
      (await pool.query('SELECT created_by_user_id FROM groups WHERE id=$1', [group.id])).rows,
    ).toEqual([{ created_by_user_id: first }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE event_type='group.member_removed' AND metadata->>'groupId'=$1",
          [group.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it('rolls back creation, metadata and every membership mutation when mandatory audit insertion fails', async () => {
    const { first, second, third, workspace, group } = await twoOwners();
    const audit = (await pool.query<{ id: string }>('SELECT id FROM audit_events LIMIT 1'))
      .rows[0]!;
    const common = {
      actorId: first,
      workspaceId: workspace.id,
      groupId: group.id,
      occurredAt: new Date(),
      auditId: audit.id,
    };
    await expect(
      repository.update({ ...common, changes: { visibility: 'workspace' } }),
    ).rejects.toThrow();
    await expect(
      repository.changeRole({ ...common, targetUserId: second, role: 'member' }),
    ).rejects.toThrow();
    await expect(repository.removeMember({ ...common, targetUserId: second })).rejects.toThrow();
    await expect(
      repository.addMember({ ...common, targetUserId: third, role: 'member' }),
    ).rejects.toThrow();
    const failedGroup = randomUUID();
    await expect(
      repository.create({
        ...common,
        id: failedGroup,
        name: 'Must rollback',
        description: '',
        visibility: 'private',
      }),
    ).rejects.toThrow();
    expect((await groups.get(first, workspace.id, group.id)).visibility).toBe('private');
    expect(
      (await groups.members(first, workspace.id, group.id))
        .map((member) => ({ id: member.user.id, role: member.role }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([first, second].sort().map((id) => ({ id, role: 'owner' })));
    expect(
      (await pool.query('SELECT id FROM groups WHERE id=$1', [failedGroup])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query('SELECT user_id FROM group_memberships WHERE group_id=$1', [failedGroup]))
        .rows,
    ).toHaveLength(0);
  });
});

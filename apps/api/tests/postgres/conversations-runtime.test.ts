import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
import {
  ConversationAccessError,
  ConversationConflictError,
  ConversationService,
} from '../../src/conversations/service.js';
import {
  ConversationTransaction,
  PostgresConversationRepository,
} from '../../src/conversations/postgres-repository.js';
import { GroupService } from '../../src/groups/service.js';
import { PostgresGroupRepository } from '../../src/groups/postgres-group-repository.js';
import { lockAuthorizedGroup } from '../../src/groups/postgres-group-access.js';

// The provisioner changes a fixed runtime role's password. Use the dedicated
// disposable conversation PostgreSQL service, never another native job's server.
const databaseUrl = process.env.TEST_CONVERSATION_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'conversation ledger with deployed PostgreSQL privileges',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let runtime: pg.Pool;
    beforeAll(async () => {
      await migrateDatabase(admin);
      const url = new URL(databaseUrl!);
      const password = `ci-conversation-${randomBytes(24).toString('hex')}`;
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
    afterAll(async () => {
      await runtime?.end();
      await admin.end();
    });
    function service(pool = runtime, now?: () => Date) {
      return new ConversationService(new PostgresConversationRepository(pool, now));
    }
    async function fixture() {
      const ownerId = randomUUID(),
        actorId = randomUUID(),
        workspaceId = randomUUID();
      for (const id of [ownerId, actorId])
        await runtime.query(
          'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
          [id, `${id}@example.com`, 'Ledger author'],
        );
      await runtime.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
        workspaceId,
        'Ledger',
      ]);
      for (const [id, role] of [
        [ownerId, 'owner'],
        [actorId, 'member'],
      ])
        await runtime.query(
          'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
          [workspaceId, id, role],
        );
      const group = await new GroupService(new PostgresGroupRepository(runtime)).create(
        ownerId,
        workspaceId,
        { name: 'History' },
      );
      await runtime.query(
        "INSERT INTO group_memberships(group_id,user_id,role,created_at) VALUES($1,$2,'member',NOW())",
        [group.id, actorId],
      );
      const conversation = await service().open(actorId, workspaceId, {
        subject: { kind: 'group', id: group.id },
      });
      return { ownerId, actorId, workspaceId, groupId: group.id, conversationId: conversation.id };
    }
    async function counts(conversationId: string) {
      return (
        await admin.query(
          `SELECT
      (SELECT last_sequence::int FROM conversations WHERE id=$1) AS sequence,
      (SELECT COUNT(*)::int FROM conversation_events WHERE conversation_id=$1) AS events,
      (SELECT COUNT(*)::int FROM audit_events WHERE event_type LIKE 'conversation.message_%' AND metadata->>'conversationId'=$1::text) AS audits`,
          [conversationId],
        )
      ).rows[0];
    }
    function observedPool() {
      const name = `ledger-${randomUUID()}`;
      return {
        name,
        pool: new pg.Pool({
          connectionString: runtime.options.connectionString,
          application_name: name,
          statement_timeout: 15000,
        }),
      };
    }
    async function blocked(name: string, blockerPid: number) {
      await vi.waitFor(
        async () => {
          const found = await admin.query(
            "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",
            [name, blockerPid],
          );
          expect(found.rows).toHaveLength(1);
        },
        { timeout: 5000, interval: 20 },
      );
    }

    it('enforces exact append-only grants, owner-level immutable guards and same-workspace subjects', async () => {
      const f = await fixture();
      const receipt = await service().append(f.actorId, f.workspaceId, f.conversationId, {
        idempotencyKey: 'immutable',
        body: 'Original',
      });
      for (const table of ['conversations', 'conversation_events'])
        for (const privilege of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          expect(
            (
              await admin.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [
                'openbot_runtime',
                table,
                privilege,
              ])
            ).rows[0].allowed,
            `${table} ${privilege}`,
          ).toBe(['SELECT', 'INSERT'].includes(privilege));
        }
      const columns = await admin.query(
        "SELECT table_name,column_name,has_column_privilege('openbot_runtime',table_name,column_name,'UPDATE') AS allowed FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('conversations','conversation_events')",
      );
      expect(columns.rows.filter((row) => row.allowed)).toEqual([
        { table_name: 'conversations', column_name: 'last_sequence', allowed: true },
      ]);
      for (const name of ['reject_conversation_event_mutation()', 'protect_conversation_subject()'])
        expect(
          (
            await admin.query('SELECT has_function_privilege($1,$2,$3) AS allowed', [
              'openbot_runtime',
              name,
              'EXECUTE',
            ])
          ).rows[0].allowed,
        ).toBe(false);
      for (const statement of [
        "UPDATE conversation_events SET body='Changed' WHERE id=$1",
        'DELETE FROM conversation_events WHERE id=$1',
      ]) {
        await expect(runtime.query(statement, [receipt.eventId])).rejects.toMatchObject({
          code: '42501',
        });
        await expect(admin.query(statement, [receipt.eventId])).rejects.toMatchObject({
          code: '55000',
        });
      }
      for (const table of ['conversation_events', 'conversations']) {
        await expect(runtime.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({
          code: '42501',
        });
        await expect(admin.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({
          code: '55000',
        });
      }
      await expect(
        admin.query('UPDATE conversations SET creator_user_id=$2 WHERE id=$1', [
          f.conversationId,
          f.ownerId,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        admin.query('UPDATE conversations SET last_sequence=0 WHERE id=$1', [f.conversationId]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        runtime.query('ALTER TABLE conversation_events DISABLE TRIGGER ALL'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        admin.query('DELETE FROM groups WHERE id=$1', [f.groupId]),
      ).rejects.toMatchObject({ code: '23503' });
      const other = await fixture();
      const foreignGroup = await new GroupService(new PostgresGroupRepository(runtime)).create(
        other.ownerId,
        other.workspaceId,
        { name: 'Other scope' },
      );
      await expect(
        runtime.query(
          'INSERT INTO conversations(id,workspace_id,group_id,creator_user_id,created_at) VALUES($1,$2,$3,$4,NOW())',
          [randomUUID(), f.workspaceId, foreignGroup.id, f.actorId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      expect(await counts(f.conversationId)).toEqual({ sequence: 1, events: 1, audits: 1 });
    });
    it('collapses simultaneous identical commands and replays the durable receipt after reconstruction', async () => {
      const f = await fixture();
      const command = { idempotencyKey: 'concurrent-same', body: 'One logical message' };
      const receipts = await Promise.all(
        Array.from({ length: 12 }, () =>
          service().append(f.actorId, f.workspaceId, f.conversationId, command),
        ),
      );
      expect(receipts.every((value) => JSON.stringify(value) === JSON.stringify(receipts[0]))).toBe(
        true,
      );
      expect(await counts(f.conversationId)).toEqual({ sequence: 1, events: 1, audits: 1 });
      expect(await service().append(f.actorId, f.workspaceId, f.conversationId, command)).toEqual(
        receipts[0],
      );
      const opens = await Promise.all(
        Array.from({ length: 4 }, () =>
          service().open(f.actorId, f.workspaceId, { subject: { kind: 'group', id: f.groupId } }),
        ),
      );
      expect(new Set(opens.map((value) => value.id))).toEqual(new Set([f.conversationId]));
    }, 15000);
    it('orders distinct concurrent appends using one durable conversation counter', async () => {
      const f = await fixture();
      const receipts = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          service().append(f.actorId, f.workspaceId, f.conversationId, {
            idempotencyKey: `message-${index}`,
            body: `Message ${index}`,
          }),
        ),
      );
      expect(receipts.map((value) => value.sequence).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(new Set(receipts.map((value) => value.eventId)).size).toBe(12);
      expect(await counts(f.conversationId)).toEqual({ sequence: 12, events: 12, audits: 12 });
      expect(
        (await service().get(f.actorId, f.workspaceId, f.conversationId, {})).messages.map(
          (message) => message.creationSequence,
        ),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }, 15000);
    it('rejects competing payload reuse and competing edit preconditions without burning positions', async () => {
      const f = await fixture();
      const initial = await Promise.allSettled(
        ['A', 'B'].map((body) =>
          service().append(f.actorId, f.workspaceId, f.conversationId, {
            idempotencyKey: 'payload-race',
            body,
          }),
        ),
      );
      expect(initial.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      const failure = initial.find((value) => value.status === 'rejected');
      expect(failure && failure.status === 'rejected' ? failure.reason : null).toBeInstanceOf(
        ConversationConflictError,
      );
      expect(await counts(f.conversationId)).toEqual({ sequence: 1, events: 1, audits: 1 });
      const message = (await service().get(f.actorId, f.workspaceId, f.conversationId, {}))
        .messages[0]!;
      const edits = await Promise.allSettled(
        ['edit-A', 'edit-B'].map((idempotencyKey) =>
          service().edit(f.actorId, f.workspaceId, f.conversationId, message.id, {
            idempotencyKey,
            expectedVersion: 1,
            body: idempotencyKey,
          }),
        ),
      );
      expect(edits.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      const loser = edits.find((value) => value.status === 'rejected');
      expect(loser && loser.status === 'rejected' ? loser.reason : null).toMatchObject({
        code: 'message_version_conflict',
      });
      expect(await counts(f.conversationId)).toEqual({ sequence: 2, events: 2, audits: 2 });
      expect(
        (await service().versions(f.actorId, f.workspaceId, f.conversationId, message.id)).map(
          (event) => event.version,
        ),
      ).toEqual([1, 2]);
    });
    it('rolls back counter, command key, event and mandatory audit on actual privilege failure', async () => {
      const f = await fixture(),
        command = { idempotencyKey: 'retry-after-rollback', body: 'Retained command' };
      await admin.query('REVOKE INSERT ON audit_events FROM openbot_runtime');
      try {
        await expect(
          service().append(f.actorId, f.workspaceId, f.conversationId, command),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query('GRANT INSERT ON audit_events TO openbot_runtime');
      }
      expect(await counts(f.conversationId)).toEqual({ sequence: 0, events: 0, audits: 0 });
      expect(
        await service().append(f.actorId, f.workspaceId, f.conversationId, command),
      ).toMatchObject({ sequence: 1 });
    });
    it('leaves dependent-write commit and rollback inside the same borrowed transaction', async () => {
      const f = await fixture(),
        connection = await runtime.connect();
      const command = { idempotencyKey: 'dependent', body: 'Atomic with a later operation' };
      try {
        await connection.query('BEGIN');
        const ledger = await ConversationTransaction.lock(connection, {
          actorUserId: f.actorId,
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
        });
        expect((await ledger.append(command)).replayed).toBe(false);
        await expect(connection.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
        await connection.query('ROLLBACK');
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect(await counts(f.conversationId)).toEqual({ sequence: 0, events: 0, audits: 0 });
      expect(
        await service().append(f.actorId, f.workspaceId, f.conversationId, command),
      ).toMatchObject({ sequence: 1 });
    });
    it.each(['group', 'workspace'] as const)(
      'rejects an actor whose %s access was removed while waiting for admission',
      async (scope) => {
        const f = await fixture(),
          blocker = await runtime.connect(),
          observer = observedPool();
        let pending: Promise<{ receipt?: unknown; error?: unknown }> | undefined;
        try {
          await blocker.query('BEGIN');
          await lockAuthorizedGroup(
            blocker,
            { actorId: f.ownerId, workspaceId: f.workspaceId, groupId: f.groupId },
            'manage',
          );
          const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          await blocker.query(
            scope === 'group'
              ? 'DELETE FROM group_memberships WHERE group_id=$1 AND user_id=$2'
              : 'DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
            [scope === 'group' ? f.groupId : f.workspaceId, f.actorId],
          );
          pending = service(observer.pool)
            .append(f.actorId, f.workspaceId, f.conversationId, {
              idempotencyKey: 'waiting',
              body: 'Must not commit',
            })
            .then(
              (receipt) => ({ receipt }),
              (error) => ({ error }),
            );
          await blocked(observer.name, pid);
          await blocker.query('COMMIT');
          expect((await pending).error).toBeInstanceOf(ConversationAccessError);
          expect(await counts(f.conversationId)).toEqual({ sequence: 0, events: 0, audits: 0 });
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await pending;
          await observer.pool.end();
        }
      },
      15000,
    );
    it('commits an admitted message before a waiting removal, then denies later replay', async () => {
      const f = await fixture(),
        connection = await runtime.connect(),
        observer = observedPool();
      let removal: Promise<unknown> | undefined;
      const command = { idempotencyKey: 'before-removal', body: 'Committed before revocation' };
      try {
        await connection.query('BEGIN');
        const ledger = await ConversationTransaction.lock(connection, {
          actorUserId: f.actorId,
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
        });
        const receipt = (await ledger.append(command)).receipt;
        const pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        removal = new PostgresGroupRepository(observer.pool).removeMember({
          actorId: f.ownerId,
          workspaceId: f.workspaceId,
          groupId: f.groupId,
          targetUserId: f.actorId,
          auditId: randomUUID(),
          occurredAt: new Date(),
        });
        await blocked(observer.name, pid);
        await connection.query('COMMIT');
        await removal;
        expect(receipt.sequence).toBe(1);
        expect(await counts(f.conversationId)).toEqual({ sequence: 1, events: 1, audits: 1 });
        await expect(
          service().append(f.actorId, f.workspaceId, f.conversationId, command),
        ).rejects.toBeInstanceOf(ConversationAccessError);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        await removal;
        await observer.pool.end();
      }
    }, 15000);
    it('samples message and audit time only after the final admission wait', async () => {
      const f = await fixture(),
        blocker = await runtime.connect(),
        observer = observedPool();
      let clock = new Date('2030-01-01T00:00:00Z');
      let pending: ReturnType<ConversationService['append']> | undefined;
      try {
        await blocker.query('BEGIN');
        await lockAuthorizedGroup(
          blocker,
          { actorId: f.ownerId, workspaceId: f.workspaceId, groupId: f.groupId },
          'manage',
        );
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = service(observer.pool, () => clock).append(
          f.actorId,
          f.workspaceId,
          f.conversationId,
          { idempotencyKey: 'post-wait-time', body: 'After waiting' },
        );
        await blocked(observer.name, pid);
        clock = new Date('2030-01-01T00:10:00Z');
        await blocker.query('COMMIT');
        const receipt = await pending;
        expect(
          (
            await admin.query('SELECT occurred_at FROM conversation_events WHERE id=$1', [
              receipt.eventId,
            ])
          ).rows[0].occurred_at,
        ).toEqual(clock);
        expect(
          (
            await admin.query(
              "SELECT occurred_at FROM audit_events WHERE metadata->>'eventId'=$1",
              [receipt.eventId],
            )
          ).rows,
        ).toEqual([{ occurred_at: clock }]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
        await observer.pool.end();
      }
    }, 15000);
  },
);

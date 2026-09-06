import type { SqlPool, SqlConnection } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedBot, type BotAccess, type BotRow } from './postgres-bot-access.js';
import {
  BotAclConflictError,
  BotAclMemberNotFoundError,
  LastBotOwnerError,
  type BotAclMember,
  type BotAclGrant,
  type BotAclRepository,
  type BotAclRemoval,
  type BotVisibilityChange,
} from './acl-service.js';
import type { BotRole } from './service.js';
import { GroupBotRevocations } from '../group-bots/postgres-closures.js';

type MemberRow = {
  user_id: string;
  email: string;
  display_name: string;
  role: BotRole;
  created_at: Date;
  has_workspace_access: boolean;
};
function member(row: MemberRow): BotAclMember {
  return {
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
    role: row.role,
    joinedAt: row.created_at,
    hasWorkspaceAccess: row.has_workspace_access,
  };
}
export class PostgresBotAclRepository implements BotAclRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async manage<T>(
    access: BotAccess,
    operation: (
      connection: SqlConnection,
      bot: BotRow,
      revocations?: GroupBotRevocations,
    ) => Promise<T>,
    revokingUserId?: string,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const revocations = revokingUserId
        ? await GroupBotRevocations.forBotRevocation(
            connection,
            { ...access, targetUserId: revokingUserId },
            this.now,
          )
        : undefined;
      const bot = await lockAuthorizedBot(connection, access, 'manageAcl');
      const result = await operation(connection, bot, revocations);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  list(access: BotAccess) {
    return this.manage(access, async (connection, bot) => {
      const result = await connection.query<MemberRow>(
        `SELECT a.user_id,u.email,u.display_name,a.role,a.created_at,(wm.user_id IS NOT NULL) AS has_workspace_access FROM bot_acl a INNER JOIN users u ON u.id=a.user_id LEFT JOIN workspace_memberships wm ON wm.user_id=a.user_id AND wm.workspace_id=$1 WHERE a.bot_id=$2 ORDER BY a.created_at,a.user_id`,
        [bot.workspace_id, bot.id],
      );
      return result.rows.map(member);
    });
  }
  changeRole(record: BotAclGrant) {
    return this.mutateMember(record, record.role);
  }
  async revoke(record: BotAclRemoval): Promise<void> {
    await this.mutateMember(record, null);
  }
  private mutateMember(record: BotAclRemoval, role: BotRole | null) {
    return this.manage(
      record,
      async (connection, bot, revocations) => {
        const target = (
          await connection.query<MemberRow>(
            `SELECT a.user_id,u.email,u.display_name,a.role,a.created_at,(wm.user_id IS NOT NULL) AS has_workspace_access FROM bot_acl a INNER JOIN users u ON u.id=a.user_id LEFT JOIN workspace_memberships wm ON wm.user_id=a.user_id AND wm.workspace_id=$1 WHERE a.bot_id=$2 AND a.user_id=$3`,
            [bot.workspace_id, bot.id, record.targetUserId],
          )
        ).rows[0];
        if (!target) throw new BotAclMemberNotFoundError();
        const rank = { user: 1, editor: 2, owner: 3 } as const;
        if (!target.has_workspace_access && role !== null && rank[role] > rank[target.role])
          throw new BotAclMemberNotFoundError();
        if (target.role === 'owner' && target.has_workspace_access && role !== 'owner') {
          const owners =
            (
              await connection.query<{ count: number }>(
                "SELECT COUNT(*)::int AS count FROM bot_acl a INNER JOIN workspace_memberships m ON m.user_id=a.user_id AND m.workspace_id=$1 WHERE a.bot_id=$2 AND a.role='owner'",
                [bot.workspace_id, bot.id],
              )
            ).rows[0]?.count ?? 0;
          if (owners <= 1) throw new LastBotOwnerError();
        }
        if (role === target.role) return member(target);
        const occurredAt = this.now();
        const metadata = {
          workspaceId: bot.workspace_id,
          botId: bot.id,
          targetUserId: target.user_id,
        };
        if (role === null) {
          await revocations!.close();
          await connection.query('DELETE FROM bot_acl WHERE bot_id=$1 AND user_id=$2', [
            bot.id,
            target.user_id,
          ]);
          await connection.query(
            "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'bot.acl_revoked',$2,$3,$4::jsonb)",
            [
              record.auditId,
              record.actorUserId,
              occurredAt,
              JSON.stringify({ ...metadata, role: target.role }),
            ],
          );
        } else {
          await connection.query('UPDATE bot_acl SET role=$3 WHERE bot_id=$1 AND user_id=$2', [
            bot.id,
            target.user_id,
            role,
          ]);
          await connection.query(
            "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'bot.acl_role_changed',$2,$3,$4::jsonb)",
            [
              record.auditId,
              record.actorUserId,
              occurredAt,
              JSON.stringify({ ...metadata, fromRole: target.role, toRole: role }),
            ],
          );
        }
        return member({ ...target, role: role ?? target.role });
      },
      role === null ? record.targetUserId : undefined,
    );
  }
  changeVisibility(record: BotVisibilityChange) {
    return this.manage(record, async (connection, bot) => {
      if (bot.visibility === record.visibility) return { visibility: bot.visibility };
      const occurredAt = this.now();
      await connection.query('UPDATE bots SET visibility=$3 WHERE workspace_id=$1 AND id=$2', [
        bot.workspace_id,
        bot.id,
        record.visibility,
      ]);
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'bot.visibility_changed',$2,$3,$4::jsonb)",
        [
          record.auditId,
          record.actorUserId,
          occurredAt,
          JSON.stringify({
            workspaceId: bot.workspace_id,
            botId: bot.id,
            fromVisibility: bot.visibility,
            toVisibility: record.visibility,
          }),
        ],
      );
      return { visibility: record.visibility };
    });
  }
  grant(record: BotAclGrant) {
    return this.manage(record, async (connection, bot) => {
      const target = (
        await connection.query<{ id: string; email: string; display_name: string }>(
          'SELECT u.id,u.email,u.display_name FROM users u INNER JOIN workspace_memberships m ON m.user_id=u.id WHERE m.workspace_id=$1 AND u.id=$2',
          [bot.workspace_id, record.targetUserId],
        )
      ).rows[0];
      if (!target) throw new BotAclMemberNotFoundError();
      const existing = await connection.query(
        'SELECT user_id FROM bot_acl WHERE bot_id=$1 AND user_id=$2',
        [bot.id, target.id],
      );
      if (existing.rows[0]) throw new BotAclConflictError();
      const occurredAt = this.now();
      await connection.query(
        'INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,$3,$4)',
        [bot.id, target.id, record.role, occurredAt],
      );
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'bot.acl_granted',$2,$3,$4::jsonb)",
        [
          record.auditId,
          record.actorUserId,
          occurredAt,
          JSON.stringify({
            workspaceId: bot.workspace_id,
            botId: bot.id,
            targetUserId: target.id,
            role: record.role,
          }),
        ],
      );
      return member({
        user_id: target.id,
        email: target.email,
        display_name: target.display_name,
        role: record.role,
        created_at: occurredAt,
        has_workspace_access: true,
      });
    });
  }
}

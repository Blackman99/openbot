import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { randomUUID } from 'node:crypto';
import { groupBotAccess, groupBotUuid } from '../group-bots/service.js';
import { GroupBotTransaction } from '../group-bots/postgres-admission.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { admitBotModel } from '../bots/model-binding.js';

export class RoutingSettingInputError extends Error {}
export class RoutingSettingConflictError extends Error {}

export interface RoutingSettingView {
  groupId: string;
  revision: number;
  canManage: boolean;
  defaultLead: null | {
    grantId: string;
    bot: { id: string; name: string; roleDescription: string };
    closed: boolean;
  };
}

export class GroupRoutingService {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async transaction<T>(operation: (connection: SqlConnection) => Promise<T>) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  get(actorUserId: string, workspaceId: string, groupId: string) {
    const access = groupBotAccess(actorUserId, workspaceId, groupId);
    return this.transaction(async (connection) => {
      const group = await lockAuthorizedGroup(
        connection,
        {
          actorId: access.actorUserId,
          workspaceId: access.workspaceId,
          groupId: access.groupId,
        },
        'content',
      );
      return this.readSetting(connection, access.groupId, group.role !== 'member');
    });
  }

  update(actorUserId: string, workspaceId: string, groupId: string, input: unknown) {
    const access = groupBotAccess(actorUserId, workspaceId, groupId);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new RoutingSettingInputError();
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !['expectedRevision', 'defaultGrantId'].includes(key)) ||
      !Number.isInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      Number(value.expectedRevision) >= 2147483647 ||
      (value.defaultGrantId !== null && typeof value.defaultGrantId !== 'string')
    )
      throw new RoutingSettingInputError();
    const defaultGrantId =
      value.defaultGrantId === null ? null : groupBotUuid(value.defaultGrantId);
    return this.transaction(async (connection) => {
      await lockAuthorizedGroup(
        connection,
        {
          actorId: access.actorUserId,
          workspaceId: access.workspaceId,
          groupId: access.groupId,
        },
        'manage',
      );
      const previous = (
        await connection.query<{ revision: number; default_grant_id: string | null }>(
          'SELECT revision,default_grant_id FROM group_routing_settings WHERE group_id=$1',
          [access.groupId],
        )
      ).rows[0];
      if ((previous?.revision ?? 0) !== value.expectedRevision)
        throw new RoutingSettingConflictError();
      if (defaultGrantId) {
        const grant = await GroupBotTransaction.lock(connection, {
          ...access,
          grantId: defaultGrantId,
        });
        const target = await grant.executionTarget();
        await admitBotModel(
          connection,
          access.actorUserId,
          access.workspaceId,
          target.configuration.modelBinding,
        );
      }
      if ((previous?.default_grant_id ?? null) === defaultGrantId)
        return this.readSetting(connection, access.groupId, true);
      const revision = (previous?.revision ?? 0) + 1;
      const at = this.now();
      if (previous) {
        await connection.query(
          'UPDATE group_routing_settings SET default_grant_id=$2,revision=$3,updated_by_user_id=$4,updated_at=$5 WHERE group_id=$1',
          [access.groupId, defaultGrantId, revision, access.actorUserId, at],
        );
      } else {
        await connection.query(
          'INSERT INTO group_routing_settings(group_id,workspace_id,default_grant_id,revision,updated_by_user_id,updated_at) VALUES($1,$2,$3,$4,$5,$6)',
          [access.groupId, access.workspaceId, defaultGrantId, revision, access.actorUserId, at],
        );
      }
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'group.routing_updated',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          access.actorUserId,
          at,
          JSON.stringify({
            workspaceId: access.workspaceId,
            groupId: access.groupId,
            revision,
            previousDefaultGrantId: previous?.default_grant_id ?? null,
            defaultGrantId,
          }),
        ],
      );
      return this.readSetting(connection, access.groupId, true);
    });
  }

  private async readSetting(
    connection: SqlConnection,
    groupId: string,
    canManage: boolean,
  ): Promise<RoutingSettingView> {
    const setting = (
      await connection.query<{ revision: number; default_grant_id: string | null }>(
        'SELECT revision,default_grant_id FROM group_routing_settings WHERE group_id=$1',
        [groupId],
      )
    ).rows[0];
    if (!setting?.default_grant_id)
      return { groupId, revision: setting?.revision ?? 0, defaultLead: null, canManage };
    const grant = (
      await connection.query<{
        bot_id: string;
        close_event_id: string | null;
        configuration: { name: string; roleDescription: string };
      }>(
        `SELECT g.bot_id,g.close_event_id,v.configuration FROM group_bot_grants g
       JOIN bots b ON b.id=g.bot_id JOIN bot_versions v ON v.id=b.current_version_id
       WHERE g.id=$1 AND g.group_id=$2`,
        [setting.default_grant_id, groupId],
      )
    ).rows[0];
    if (!grant) throw new Error('Routing setting reference is unavailable');
    return {
      groupId,
      revision: setting.revision,
      canManage,
      defaultLead: {
        grantId: setting.default_grant_id,
        bot: {
          id: grant.bot_id,
          name: grant.configuration.name,
          roleDescription: grant.configuration.roleDescription,
        },
        closed: grant.close_event_id !== null,
      },
    };
  }
}

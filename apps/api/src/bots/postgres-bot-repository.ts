import type { SqlPool, SqlConnection } from '../auth/postgres-auth-repository.js';
import { admitBotModel } from './model-binding.js';
import {
  botVersion,
  lockAuthorizedBot,
  lockBotWorkspace,
  readVisibleBots,
  type BotRow,
} from './postgres-bot-access.js';
import {
  BotModelError,
  type BotCreate,
  type BotListView,
  type BotDetail,
  type BotRepository,
  type BindingStatus,
  type BotSummary,
} from './service.js';

export class PostgresBotRepository implements BotRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async read<T>(
    actorUserId: string,
    workspaceId: string,
    operation: (connection: SqlConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await lockBotWorkspace(connection, actorUserId, workspaceId);
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
  private async bindingStatus(
    connection: SqlConnection,
    actorUserId: string,
    row: BotRow,
  ): Promise<BindingStatus> {
    try {
      const admitted = await admitBotModel(
        connection,
        actorUserId,
        row.workspace_id,
        row.configuration.modelBinding,
      );
      return { state: 'ready', chatOnly: admitted.chatOnly };
    } catch (error) {
      if (error instanceof BotModelError) return { state: 'unavailable', reason: error.reason };
      throw error;
    }
  }
  private summary(row: BotRow, bindingStatus: BindingStatus): BotSummary {
    return {
      lifecycleState: row.lifecycle_state,
      ...(row.role && row.configuration.avatarObjectId ? { avatarVersionId: row.version_id } : {}),
      id: row.id,
      workspaceId: row.workspace_id,
      visibility: row.visibility,
      accessRole: row.role,
      name: row.configuration.name,
      roleDescription: row.configuration.roleDescription,
      description: row.configuration.description,
      bindingStatus,
    };
  }
  list(
    actorUserId: string,
    workspaceId: string,
    view: BotListView = 'default',
  ): Promise<BotSummary[]> {
    return this.read(actorUserId, workspaceId, async (connection) => {
      const rows = await readVisibleBots(connection, actorUserId, workspaceId);
      const statuses = new Map<string, BindingStatus>();
      const bots: BotSummary[] = [];
      for (const row of rows) {
        if (
          view === 'deleted'
            ? row.lifecycle_state !== 'deleted' || row.role !== 'owner'
            : view === 'usable'
              ? row.lifecycle_state !== 'active' || !row.role
              : row.lifecycle_state === 'deleted'
        )
          continue;
        const binding = row.configuration.modelBinding;
        const key = JSON.stringify([
          binding.scope.kind,
          binding.scope.id,
          binding.connectionId,
          binding.modelId,
        ]);
        let status = statuses.get(key);
        if (!status) {
          status = await this.bindingStatus(connection, actorUserId, row);
          statuses.set(key, status);
        }
        bots.push(this.summary(row, status));
      }
      return bots;
    });
  }
  get(actorUserId: string, workspaceId: string, botId: string): Promise<BotDetail> {
    return this.read(actorUserId, workspaceId, async (connection) => {
      const row = await lockAuthorizedBot(
        connection,
        { actorUserId, workspaceId, botId },
        'discover',
      );
      return {
        ...this.summary(row, await this.bindingStatus(connection, actorUserId, row)),
        ...(row.role ? { currentVersion: botVersion(row) } : {}),
      };
    });
  }
  async create(record: BotCreate): Promise<BotDetail> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const author = await lockBotWorkspace(connection, record.actorUserId, record.workspaceId);
      const binding = record.configuration.modelBinding;
      const admitted = await admitBotModel(
        connection,
        record.actorUserId,
        record.workspaceId,
        binding,
      );
      const occurredAt = this.now();
      await connection.query(
        "INSERT INTO bots(id,workspace_id,current_version_id,visibility,created_by_user_id,created_at) VALUES($1,$2,$3,'private',$4,$5)",
        [record.id, record.workspaceId, record.versionId, record.actorUserId, occurredAt],
      );
      await connection.query(
        "INSERT INTO bot_versions(id,bot_id,version,configuration,author_user_id,created_at,rationale) VALUES($1,$2,1,$3::jsonb,$4,$5,'Created')",
        [
          record.versionId,
          record.id,
          JSON.stringify(record.configuration),
          record.actorUserId,
          occurredAt,
        ],
      );
      await connection.query(
        "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)",
        [record.id, record.actorUserId, occurredAt],
      );
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'bot.created',$2,$3,$4::jsonb)",
        [
          record.auditId,
          record.actorUserId,
          occurredAt,
          JSON.stringify({
            botId: record.id,
            workspaceId: record.workspaceId,
            versionId: record.versionId,
            version: 1,
          }),
        ],
      );
      await connection.query('COMMIT');
      return {
        lifecycleState: 'active',
        id: record.id,
        workspaceId: record.workspaceId,
        visibility: 'private',
        accessRole: 'owner',
        name: record.configuration.name,
        roleDescription: record.configuration.roleDescription,
        description: record.configuration.description,
        bindingStatus: { state: 'ready', chatOnly: admitted.chatOnly },
        currentVersion: {
          id: record.versionId,
          number: 1,
          author: { id: author.id, displayName: author.display_name },
          createdAt: occurredAt,
          rationale: 'Created',
          configuration: record.configuration,
        },
      };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}

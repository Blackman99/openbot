import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { avatarAccess } from './avatar-service.js';
import { BotVersionConflictError, validateBotAvatarReference } from './append-version.js';
import { admitBotModel } from './model-binding.js';
import { lockAuthorizedBot, type BotAccess } from './postgres-bot-access.js';
import {
  BotAccessError,
  BotInputError,
  BotModelError,
  parseBotConfiguration,
  type BindingStatus,
  type BotConfiguration,
  type BotDetail,
} from './service.js';
import { versionId, versionObject } from './version-data.js';

export const COPY_INCLUDED = [
  'identity',
  'instructions',
  'executionLimits',
  'avatarReference',
  'modelBinding',
] as const;
export const COPY_EXCLUDED = [
  'credentials',
  'acls',
  'history',
  'memory',
  'fileContents',
  'audits',
] as const;
export interface BotCopyPreview {
  sourceBotId: string;
  sourceVersionId: string;
  sourceVersionNumber: number;
  configuration: BotConfiguration;
  bindingStatus: BindingStatus;
  included: typeof COPY_INCLUDED;
  excluded: typeof COPY_EXCLUDED;
}
// Copy from an explicit field allowlist, never spread a persisted JSON record.
function copyConfiguration(source: BotConfiguration, replacement?: unknown): BotConfiguration {
  return parseBotConfiguration({
    name: source.name,
    roleDescription: source.roleDescription,
    description: source.description,
    instructions: source.instructions,
    modelBinding: replacement ?? source.modelBinding,
    limits: source.limits,
  });
}
export class BotCopyService {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}
  access(actor: string, workspace: string, bot: string) {
    return avatarAccess(actor, workspace, bot);
  }
  private async transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
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
  preview(access: BotAccess): Promise<BotCopyPreview> {
    return this.transaction(async (connection) => {
      const source = await lockAuthorizedBot(connection, access, 'inspect');
      if (source.lifecycle_state === 'deleted') throw new BotAccessError();
      const configuration = copyConfiguration(source.configuration);
      let bindingStatus: BindingStatus;
      try {
        const admitted = await admitBotModel(
          connection,
          access.actorUserId,
          access.workspaceId,
          configuration.modelBinding,
        );
        bindingStatus = { state: 'ready', chatOnly: admitted.chatOnly };
      } catch (error) {
        if (!(error instanceof BotModelError)) throw error;
        bindingStatus = { state: 'unavailable', reason: error.reason };
      }
      if (source.configuration.avatarObjectId) {
        await validateBotAvatarReference(
          connection,
          access,
          source.configuration.avatarObjectId,
          source.version_id,
        );
        configuration.avatarObjectId = source.configuration.avatarObjectId;
      }
      return {
        sourceBotId: source.id,
        sourceVersionId: source.version_id,
        sourceVersionNumber: source.version,
        configuration,
        bindingStatus,
        included: COPY_INCLUDED,
        excluded: COPY_EXCLUDED,
      };
    });
  }
  confirm(access: BotAccess, input: unknown): Promise<BotDetail> {
    if (
      !versionObject(input) ||
      Object.keys(input).some((key) => !['expectedCurrentVersionId', 'modelBinding'].includes(key))
    )
      throw new BotInputError();
    const expectedCurrentVersionId = versionId(input.expectedCurrentVersionId);
    return this.transaction(async (connection) => {
      const source = await lockAuthorizedBot(connection, access, 'inspect');
      if (source.lifecycle_state === 'deleted') throw new BotAccessError();
      if (source.version_id !== expectedCurrentVersionId) throw new BotVersionConflictError();
      if ('modelBinding' in input && !versionObject(input.modelBinding)) throw new BotInputError();
      const configuration = copyConfiguration(source.configuration, input.modelBinding);
      const admitted = await admitBotModel(
        connection,
        access.actorUserId,
        access.workspaceId,
        configuration.modelBinding,
      );
      if (source.configuration.avatarObjectId) {
        await validateBotAvatarReference(
          connection,
          access,
          source.configuration.avatarObjectId,
          source.version_id,
        );
        configuration.avatarObjectId = source.configuration.avatarObjectId;
      }
      const id = randomUUID(),
        versionId = randomUUID(),
        occurredAt = this.now();
      await connection.query(
        "INSERT INTO bots(id,workspace_id,current_version_id,visibility,created_by_user_id,created_at) VALUES($1,$2,$3,'private',$4,$5)",
        [id, access.workspaceId, versionId, access.actorUserId, occurredAt],
      );
      await connection.query(
        "INSERT INTO bot_versions(id,bot_id,version,configuration,author_user_id,created_at,rationale) VALUES($1,$2,1,$3::jsonb,$4,$5,'Copied configuration')",
        [versionId, id, JSON.stringify(configuration), access.actorUserId, occurredAt],
      );
      if (configuration.avatarObjectId)
        await connection.query(
          'INSERT INTO bot_avatar_references(version_id,object_id) VALUES($1,$2)',
          [versionId, configuration.avatarObjectId],
        );
      await connection.query(
        "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)",
        [id, access.actorUserId, occurredAt],
      );
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'bot.copied',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          access.actorUserId,
          occurredAt,
          JSON.stringify({
            workspaceId: access.workspaceId,
            botId: id,
            versionId,
            version: 1,
            sourceBotId: source.id,
            sourceVersionId: source.version_id,
          }),
        ],
      );
      const author = (
        await connection.query<{ display_name: string }>(
          'SELECT display_name FROM users WHERE id=$1',
          [access.actorUserId],
        )
      ).rows[0]!;
      return {
        ...(configuration.avatarObjectId ? { avatarVersionId: versionId } : {}),
        id,
        workspaceId: access.workspaceId,
        visibility: 'private',
        lifecycleState: 'active',
        accessRole: 'owner',
        name: configuration.name,
        roleDescription: configuration.roleDescription,
        description: configuration.description,
        bindingStatus: { state: 'ready', chatOnly: admitted.chatOnly },
        currentVersion: {
          id: versionId,
          number: 1,
          configuration,
          author: { id: access.actorUserId, displayName: author.display_name },
          createdAt: occurredAt,
          rationale: 'Copied configuration',
        },
      };
    });
  }
}

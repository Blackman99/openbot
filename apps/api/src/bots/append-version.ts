import { admitBotModel } from './model-binding.js';
import {
  applyConfigurationChange,
  compareConfigurations,
  readBotVersion,
  versionObject,
  versionRationale,
} from './version-data.js';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedBot, botVersion, type BotAccess } from './postgres-bot-access.js';
import { type BotConfiguration, type BotVersion } from './service.js';

export class BotVersionConflictError extends Error {}
export class BotAvatarUnavailableError extends Error {}
export type BotVersionChange = { expectedCurrentVersionId: string; rationale?: string } & (
  | { kind?: 'avatar'; changes: { avatarObjectId: string | null } }
  | { kind: 'configuration'; changes: unknown }
  | { kind: 'restore'; sourceVersionId: string }
);
// Caller owns BEGIN/COMMIT and all related object publication/cleanup writes.
// All callers share fresh authority, CAS, admission and immutable audit/reference writes.
export async function appendBotVersion(
  connection: SqlConnection,
  access: BotAccess,
  change: BotVersionChange,
  now: () => Date = () => new Date(),
): Promise<BotVersion> {
  const current = await lockAuthorizedBot(connection, access, 'edit');
  if (current.version_id !== change.expectedCurrentVersionId) throw new BotVersionConflictError();
  const restored =
    change.kind === 'restore'
      ? await readBotVersion(connection, access.botId, change.sourceVersionId)
      : undefined;
  const configuration: BotConfiguration = restored
    ? restored.configuration
    : change.kind === 'configuration'
      ? applyConfigurationChange(current.configuration, change.changes)
      : change.kind !== 'restore'
        ? { ...current.configuration, avatarObjectId: change.changes.avatarObjectId }
        : current.configuration;
  const rationale =
    versionRationale(change.rationale) ??
    (restored
      ? `Restored version ${restored.number}`
      : change.kind === 'configuration'
        ? 'Configuration updated'
        : configuration.avatarObjectId
          ? 'Avatar updated'
          : 'Avatar removed');
  if (
    restored ||
    (change.kind === 'configuration' &&
      versionObject(change.changes) &&
      'modelBinding' in change.changes)
  )
    await admitBotModel(
      connection,
      access.actorUserId,
      access.workspaceId,
      configuration.modelBinding,
    );
  const differences = compareConfigurations(current.configuration, configuration);
  if (!restored && !differences.length) return botVersion(current);
  const avatarObjectId = configuration.avatarObjectId;
  if (avatarObjectId) {
    const object = (
      await connection.query<{ state: string; workspace_id: string; bot_id: string }>(
        'SELECT state,workspace_id,bot_id FROM avatar_objects WHERE id=$1 FOR UPDATE',
        [avatarObjectId],
      )
    ).rows[0];
    if (
      !object ||
      object.workspace_id !== access.workspaceId ||
      object.bot_id !== access.botId ||
      object.state !== 'live'
    )
      throw new BotAvatarUnavailableError();
    // Restore may reference only the retained object of the same Bot's source version.
    // Configuration edits carry the current reference; public patches cannot introduce storage IDs.
    const sourceVersionId =
      restored?.id ?? (change.kind === 'configuration' ? current.version_id : undefined);
    if (
      sourceVersionId &&
      !(
        await connection.query(
          'SELECT version_id FROM bot_avatar_references WHERE version_id=$1 AND object_id=$2',
          [sourceVersionId, avatarObjectId],
        )
      ).rows[0]
    )
      throw new BotAvatarUnavailableError();
  }
  const id = randomUUID(),
    occurredAt = now(),
    number = current.version + 1;
  await connection.query(
    'INSERT INTO bot_versions(id,bot_id,version,configuration,author_user_id,created_at,rationale) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',
    [
      id,
      access.botId,
      number,
      JSON.stringify(configuration),
      access.actorUserId,
      occurredAt,
      rationale,
    ],
  );
  if (avatarObjectId)
    await connection.query(
      'INSERT INTO bot_avatar_references(version_id,object_id) VALUES($1,$2)',
      [id, avatarObjectId],
    );
  await connection.query('UPDATE bots SET current_version_id=$2 WHERE id=$1', [access.botId, id]);
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'bot.version_created',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      access.actorUserId,
      occurredAt,
      JSON.stringify({
        workspaceId: access.workspaceId,
        botId: access.botId,
        versionId: id,
        previousVersionId: current.version_id,
        version: number,
        changedFields: differences.map(({ field }) => field),
        ...(restored ? { restoredFromVersionId: restored.id } : {}),
      }),
    ],
  );
  if (
    current.configuration.avatarObjectId &&
    current.configuration.avatarObjectId !== avatarObjectId
  )
    await connection.query('UPDATE avatar_objects SET cleanup_after=$2 WHERE id=$1', [
      current.configuration.avatarObjectId,
      occurredAt,
    ]);
  const author = (
    await connection.query<{ display_name: string }>('SELECT display_name FROM users WHERE id=$1', [
      access.actorUserId,
    ])
  ).rows[0]!;
  return {
    id,
    number,
    configuration,
    author: { id: access.actorUserId, displayName: author.display_name },
    createdAt: occurredAt,
    rationale,
  };
}

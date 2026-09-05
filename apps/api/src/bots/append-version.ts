import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedBot, botVersion, type BotAccess } from './postgres-bot-access.js';
import { BotInputError, type BotConfiguration, type BotVersion } from './service.js';

export class BotVersionConflictError extends Error {}
export class BotAvatarUnavailableError extends Error {}
export interface BotVersionChange {
  expectedCurrentVersionId: string;
  changes: { avatarObjectId: string | null };
  rationale?: string;
}
// Caller owns BEGIN/COMMIT and all related object publication/cleanup writes.
// BOT-03 extends this allowlisted change, rather than rewinding version pointers.
export async function appendBotVersion(
  connection: SqlConnection,
  access: BotAccess,
  change: BotVersionChange,
  now: () => Date = () => new Date(),
): Promise<BotVersion> {
  const current = await lockAuthorizedBot(connection, access, 'edit');
  if (current.version_id !== change.expectedCurrentVersionId) throw new BotVersionConflictError();
  const avatarObjectId = change.changes.avatarObjectId;
  if ((current.configuration.avatarObjectId ?? null) === avatarObjectId) return botVersion(current);
  if (avatarObjectId) {
    const object = (
      await connection.query<{ state: string; workspace_id: string }>(
        'SELECT state,workspace_id FROM avatar_objects WHERE id=$1 FOR UPDATE',
        [avatarObjectId],
      )
    ).rows[0];
    if (!object || object.workspace_id !== access.workspaceId || object.state !== 'live')
      throw new BotAvatarUnavailableError();
  }
  const rationale =
    change.rationale?.trim() || (avatarObjectId ? 'Avatar updated' : 'Avatar removed');
  if (rationale.length > 500) throw new BotInputError();
  const configuration: BotConfiguration = { ...current.configuration, avatarObjectId };
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
        changedFields: ['avatarObjectId'],
      }),
    ],
  );
  if (current.configuration.avatarObjectId)
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

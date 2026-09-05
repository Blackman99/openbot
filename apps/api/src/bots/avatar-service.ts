import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { createObjectKey, ObjectNotFoundError, type ObjectStore } from '../objects/store.js';
import { lockAuthorizedBot, type BotAccess } from './postgres-bot-access.js';
import {
  appendBotVersion,
  BotAvatarUnavailableError,
  BotVersionConflictError,
} from './append-version.js';
import { AvatarImageDecoder } from './avatar-image.js';
import { BotAccessError, BotInputError } from './service.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function avatarAccess(actorUserId: string, workspaceId: string, botId: string): BotAccess {
  if (!uuid.test(workspaceId) || !uuid.test(botId)) throw new BotAccessError();
  return {
    actorUserId: actorUserId.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    botId: botId.toLowerCase(),
  };
}
function versionId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new BotInputError();
  return value.toLowerCase();
}
export class BotAvatarService {
  constructor(
    private readonly pool: SqlPool,
    private readonly store: ObjectStore,
    private readonly decoder = new AvatarImageDecoder(),
    private readonly now: () => Date = () => new Date(),
  ) {}
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
  async cleanup(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BotInputError();
    const candidates = await this.transaction(
      async (connection) =>
        (
          await connection.query<{ id: string; workspace_id: string }>(
            "SELECT id,workspace_id FROM avatar_objects WHERE backend_id=$1 AND cleanup_after<=$2 AND (state='live' OR lease_until<=$2) ORDER BY cleanup_after,id LIMIT $3",
            [this.store.identity, this.now(), limit],
          )
        ).rows,
    );
    const counts = { retained: 0, deleted: 0, retried: 0 };
    for (const candidate of candidates) {
      const token = randomUUID();
      const claim = await this.transaction(async (connection) => {
        await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
          candidate.workspace_id,
        ]);
        const row = (
          await connection.query<{
            state: string;
            backend_id: string;
            cleanup_after: Date | null;
            lease_until: Date;
          }>(
            'SELECT state,backend_id,cleanup_after,lease_until FROM avatar_objects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
            [candidate.id, candidate.workspace_id],
          )
        ).rows[0];
        const now = this.now();
        if (
          !row ||
          row.backend_id !== this.store.identity ||
          !row.cleanup_after ||
          row.cleanup_after > now ||
          (row.state !== 'live' && row.lease_until > now)
        )
          return 'skip';
        const references = await connection.query(
          'SELECT version_id FROM bot_avatar_references WHERE object_id=$1 LIMIT 1',
          [candidate.id],
        );
        if (references.rows[0]) {
          await connection.query('UPDATE avatar_objects SET cleanup_after=$2 WHERE id=$1', [
            candidate.id,
            new Date(now.getTime() + 86_400_000),
          ]);
          return 'retained';
        }
        await connection.query(
          "UPDATE avatar_objects SET state='deleting',cleanup_token=$2,lease_until=$3,attempts=attempts+1 WHERE id=$1",
          [candidate.id, token, new Date(now.getTime() + 30_000)],
        );
        return 'claimed';
      });
      if (claim === 'retained') {
        counts.retained++;
        continue;
      }
      if (claim !== 'claimed') continue;
      try {
        await this.store.delete({ workspaceId: candidate.workspace_id, objectId: candidate.id });
        await this.transaction(async (connection) => {
          // Keep a daily tombstone reconciliation for a crashed/late remote PUT.
          await connection.query(
            "UPDATE avatar_objects SET state='deleted',cleanup_after=$3,lease_until=$4 WHERE id=$1 AND state='deleting' AND cleanup_token=$2",
            [candidate.id, token, new Date(this.now().getTime() + 86_400_000), this.now()],
          );
        });
        counts.deleted++;
      } catch {
        await this.transaction(async (connection) => {
          await connection.query(
            "UPDATE avatar_objects SET cleanup_after=$3,lease_until=$3 WHERE id=$1 AND state='deleting' AND cleanup_token=$2",
            [candidate.id, token, new Date(this.now().getTime() + 60_000)],
          );
        }).catch(() => {});
        counts.retried++;
      }
    }
    return counts;
  }
  async authorizeEdit(access: BotAccess) {
    await this.transaction(async (connection) => {
      await lockAuthorizedBot(connection, access, 'edit');
    });
  }
  async upload(
    access: BotAccess,
    expected: unknown,
    bytes: Buffer,
    mediaType: string,
    signal?: AbortSignal,
  ) {
    const expectedCurrentVersionId = versionId(expected);
    await this.authorizeEdit(access);
    signal?.throwIfAborted();
    const image = await this.decoder.decode(bytes, mediaType, signal);
    const key = createObjectKey(access.workspaceId),
      createdAt = this.now();
    const leaseUntil = new Date(createdAt.getTime() + 60_000);
    await this.transaction(async (connection) => {
      const current = await lockAuthorizedBot(connection, access, 'edit');
      if (current.version_id !== expectedCurrentVersionId) throw new BotVersionConflictError();
      await connection.query(
        "INSERT INTO avatar_objects(id,workspace_id,bot_id,backend_id,state,bytes,sha256,width,height,created_at,lease_until,cleanup_after) VALUES($1,$2,$3,$4,'staged',$5,$6,$7,$8,$9,$10,$10)",
        [
          key.objectId,
          key.workspaceId,
          access.botId,
          this.store.identity,
          image.bytes.length,
          createHash('sha256').update(image.bytes).digest('hex'),
          image.width,
          image.height,
          createdAt,
          leaseUntil,
        ],
      );
    });
    try {
      signal?.throwIfAborted();
      await this.store.save(key, image.bytes, signal);
      signal?.throwIfAborted();
      return await this.transaction(async (connection) => {
        const current = await lockAuthorizedBot(connection, access, 'edit');
        signal?.throwIfAborted();
        if (current.version_id !== expectedCurrentVersionId) throw new BotVersionConflictError();
        const object = (
          await connection.query<{ state: string; lease_until: Date }>(
            'SELECT state,lease_until FROM avatar_objects WHERE id=$1 FOR UPDATE',
            [key.objectId],
          )
        ).rows[0];
        if (!object || object.state !== 'staged' || object.lease_until <= this.now())
          throw new BotAvatarUnavailableError();
        await connection.query(
          "UPDATE avatar_objects SET state='live',cleanup_after=NULL WHERE id=$1",
          [key.objectId],
        );
        return appendBotVersion(
          connection,
          access,
          { expectedCurrentVersionId, changes: { avatarObjectId: key.objectId } },
          this.now,
        );
      });
    } catch (error) {
      // The durable staged intent already handles a crash or unavailable database.
      await this.transaction(async (connection) => {
        await connection.query(
          "UPDATE avatar_objects SET cleanup_after=$2,lease_until=$2 WHERE id=$1 AND state='staged'",
          [key.objectId, this.now()],
        );
      }).catch(() => {});
      throw error;
    }
  }
  async remove(access: BotAccess, expected: unknown) {
    const expectedCurrentVersionId = versionId(expected);
    return this.transaction((connection) =>
      appendBotVersion(
        connection,
        access,
        { expectedCurrentVersionId, changes: { avatarObjectId: null } },
        this.now,
      ),
    );
  }
  async read(access: BotAccess, requestedVersion?: unknown, signal?: AbortSignal) {
    const selectedVersion =
      requestedVersion === undefined ? undefined : versionId(requestedVersion);
    const object = await this.transaction(async (connection) => {
      const bot = await lockAuthorizedBot(connection, access, 'inspect');
      const row = (
        await connection.query<{ id: string; backend_id: string; bytes: number; sha256: string }>(
          `SELECT o.id,o.backend_id,o.bytes,o.sha256 FROM bot_versions v INNER JOIN bot_avatar_references r ON r.version_id=v.id INNER JOIN avatar_objects o ON o.id=r.object_id WHERE v.bot_id=$1 AND v.id=$2 AND o.workspace_id=$3 AND o.state='live'`,
          [access.botId, selectedVersion ?? bot.version_id, access.workspaceId],
        )
      ).rows[0];
      if (!row) throw new ObjectNotFoundError();
      if (row.backend_id !== this.store.identity) throw new BotAvatarUnavailableError();
      return row;
    });
    const bytes = await this.store.read(
      { workspaceId: access.workspaceId, objectId: object.id },
      object.bytes,
      signal,
    );
    if (
      bytes.length !== object.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== object.sha256
    )
      throw new BotAvatarUnavailableError();
    await this.transaction(async (connection) => {
      await lockAuthorizedBot(connection, access, 'inspect');
    });
    signal?.throwIfAborted();
    return bytes;
  }
}

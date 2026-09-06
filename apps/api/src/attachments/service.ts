import { GroupBotTransaction } from '../group-bots/postgres-admission.js';
import { groupBotAccess, groupBotUuid, type GroupBotAccess } from '../group-bots/service.js';
import { validateAttachment } from './validation.js';
import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { type ConversationAccess } from '../conversations/service.js';
import { createObjectKey, type ObjectStore } from '../objects/store.js';
import {
  attachmentAccess,
  attachmentLimit,
  attachmentMetadata,
  AttachmentInputError,
  AttachmentUnavailableError,
  parseAttachmentCommand,
} from './types.js';
export class AttachmentService {
  readonly maximumBytes: number;
  constructor(
    private readonly pool: SqlPool,
    private readonly store: ObjectStore,
    maximumBytes?: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.maximumBytes = attachmentLimit(maximumBytes);
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
  async authorize(access: ConversationAccess) {
    await this.transaction(async (connection) => {
      await ConversationTransaction.lock(connection, access, this.now);
    });
  }
  async upload(
    supplied: ConversationAccess,
    input: unknown,
    suppliedBytes: Buffer,
    signal?: AbortSignal,
  ) {
    const access = attachmentAccess(
      supplied.actorUserId,
      supplied.workspaceId,
      supplied.conversationId,
    );
    const command = parseAttachmentCommand(input, this.maximumBytes);
    await this.authorize(access);
    signal?.throwIfAborted();
    const bytes = Buffer.from(suppliedBytes);
    if (
      bytes.length !== command.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== command.sha256
    )
      throw new AttachmentInputError();
    await validateAttachment(bytes, command, signal);
    const key = createObjectKey(access.workspaceId),
      attachmentId = randomUUID();
    const prior = await this.transaction(async (connection) => {
      const admitted = await ConversationTransaction.lock(connection, access, this.now);
      const replay = await admitted.attachmentReplay(command);
      if (replay) return replay;
      const created = this.now(),
        lease = new Date(created.getTime() + 60_000);
      await connection.query(
        "INSERT INTO attachment_objects(id,workspace_id,conversation_id,actor_user_id,backend_id,state,filename,media_type,bytes,sha256,created_at,lease_until,cleanup_after,storage_id) VALUES($1,$2,$3,$4,$5,'staged',$6,$7,$8,$9,$10,$11,$11,$12)",
        [
          attachmentId,
          access.workspaceId,
          access.conversationId,
          access.actorUserId,
          this.store.identity,
          command.filename,
          command.mediaType,
          command.bytes,
          command.sha256,
          created,
          lease,
          key.objectId,
        ],
      );
      return undefined;
    });
    if (prior) return prior;
    let writeMayContinue = false;
    try {
      signal?.throwIfAborted();
      writeMayContinue = true;
      await this.store.save(key, bytes, signal);
      writeMayContinue = false;
      signal?.throwIfAborted();
      return await this.transaction(async (connection) => {
        const admitted = await ConversationTransaction.lock(connection, access, this.now);
        signal?.throwIfAborted();
        const receipt = await admitted.appendAttachment(command, attachmentId);
        // A competing replay may have published its own staged object.
        await connection.query(
          "UPDATE attachment_objects SET cleanup_after=$2,lease_until=$2 WHERE id=$1 AND state='staged'",
          [attachmentId, this.now()],
        );
        return receipt;
      });
    } catch (error) {
      // Adapter rejection can precede its background I/O settling. Keep the
      // durable lease in that case; only a completed/no-start write releases it.
      if (!writeMayContinue) await this.releaseWriteLease(attachmentId).catch(() => {});
      throw error;
    }
  }
  // Internal downstream artifact seam: bytes are always registered under the existing message's exact provenance before storage.
  async registerDerived(
    supplied: ConversationAccess,
    messageId: string,
    input: unknown,
    suppliedBytes: Buffer,
    signal?: AbortSignal,
  ) {
    const access = attachmentAccess(
      supplied.actorUserId,
      supplied.workspaceId,
      supplied.conversationId,
    );
    const command = parseAttachmentCommand(input, this.maximumBytes);
    const bytes = Buffer.from(suppliedBytes);
    await this.authorize(access);
    await validateAttachment(bytes, command, signal);
    const key = createObjectKey(access.workspaceId),
      attachmentId = randomUUID();
    const parent = await this.transaction(async (connection) => {
      const admitted = await ConversationTransaction.lock(connection, access, this.now);
      const original = await admitted.attachmentMetadata(messageId);
      const created = this.now(),
        lease = new Date(created.getTime() + 60000);
      await connection.query(
        "INSERT INTO attachment_objects(id,workspace_id,conversation_id,message_id,original_id,actor_user_id,backend_id,state,filename,media_type,bytes,sha256,created_at,lease_until,cleanup_after,storage_id) VALUES($1,$2,$3,$4,$5,$6,$7,'staged',$8,$9,$10,$11,$12,$13,$13,$14)",
        [
          attachmentId,
          access.workspaceId,
          access.conversationId,
          messageId,
          original.id,
          access.actorUserId,
          this.store.identity,
          command.filename,
          command.mediaType,
          command.bytes,
          command.sha256,
          created,
          lease,
          key.objectId,
        ],
      );
      return original.id;
    });
    let writeMayContinue = false;
    try {
      signal?.throwIfAborted();
      writeMayContinue = true;
      await this.store.save(key, bytes, signal);
      writeMayContinue = false;
      signal?.throwIfAborted();
      return await this.transaction(async (connection) => {
        const admitted = await ConversationTransaction.lock(connection, access, this.now);
        const original = await admitted.attachmentMetadata(messageId);
        const staged = (
          await connection.query<{ state: string; lease_until: Date }>(
            'SELECT state,lease_until FROM attachment_objects WHERE id=$1 FOR UPDATE',
            [attachmentId],
          )
        ).rows[0];
        if (
          original.id !== parent ||
          staged?.state !== 'staged' ||
          staged.lease_until <= this.now()
        )
          throw new AttachmentUnavailableError();
        signal?.throwIfAborted();
        await connection.query(
          "UPDATE attachment_objects SET state='live',cleanup_after=NULL WHERE id=$1",
          [attachmentId],
        );
        return { id: attachmentId };
      });
    } catch (error) {
      if (!writeMayContinue) await this.releaseWriteLease(attachmentId).catch(() => {});
      throw error;
    }
  }
  private async releaseWriteLease(attachmentId: string) {
    await this.transaction(async (connection) => {
      await connection.query(
        "UPDATE attachment_objects SET cleanup_after=$2,lease_until=$2 WHERE id=$1 AND state IN ('staged','purging','deleted')",
        [attachmentId, this.now()],
      );
    });
  }
  async purge(supplied: ConversationAccess, messageId: string) {
    const access = attachmentAccess(
      supplied.actorUserId,
      supplied.workspaceId,
      supplied.conversationId,
    );
    return this.transaction(async (connection) =>
      (await ConversationTransaction.lock(connection, access, this.now)).requestMessagePurge(
        messageId,
      ),
    );
  }
  async cleanup(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AttachmentInputError();
    const candidates = await this.transaction(
      async (connection) =>
        (
          await connection.query<{ id: string; workspace_id: string; conversation_id: string }>(
            'SELECT id,workspace_id,conversation_id FROM attachment_objects WHERE backend_id=$1 AND cleanup_after<=$2 AND lease_until<=$2 ORDER BY cleanup_after,id LIMIT $3',
            [this.store.identity, this.now(), limit],
          )
        ).rows,
    );
    const counts = { deleted: 0, retried: 0 };
    for (const candidate of candidates) {
      const token = randomUUID();
      const claimed = await this.transaction(async (connection) => {
        await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
          candidate.workspace_id,
        ]);
        await connection.query(
          'SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [candidate.workspace_id, candidate.conversation_id],
        );
        const row = (
          await connection.query<import('./types.js').AttachmentRow>(
            'SELECT * FROM attachment_objects WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3 FOR UPDATE',
            [candidate.id, candidate.workspace_id, candidate.conversation_id],
          )
        ).rows[0];
        if (
          !row ||
          row.backend_id !== this.store.identity ||
          row.state === 'live' ||
          !row.cleanup_after ||
          row.cleanup_after > this.now() ||
          row.lease_until > this.now()
        )
          return false;
        await connection.query(
          "UPDATE attachment_objects SET state='deleting',cleanup_token=$2,lease_until=$3,attempts=attempts+1 WHERE id=$1",
          [candidate.id, token, new Date(this.now().getTime() + 30000)],
        );
        return row.storage_id;
      });
      if (!claimed) continue;
      try {
        await this.store.delete({ workspaceId: candidate.workspace_id, objectId: claimed });
        await this.transaction(async (connection) => {
          await connection.query(
            "UPDATE attachment_objects SET state='deleted',filename=NULL,media_type=NULL,bytes=NULL,sha256=NULL,lease_until=$3,cleanup_after=$4 WHERE id=$1 AND cleanup_token=$2 AND state='deleting'",
            [candidate.id, token, this.now(), new Date(this.now().getTime() + 86400000)],
          );
        });
        counts.deleted++;
      } catch {
        await this.transaction(async (connection) => {
          await connection.query(
            "UPDATE attachment_objects SET cleanup_after=$3,lease_until=$3 WHERE id=$1 AND cleanup_token=$2 AND state='deleting'",
            [candidate.id, token, new Date(this.now().getTime() + 60000)],
          );
        }).catch(() => {});
        counts.retried++;
      }
    }
    // Finish only after every registered object has acknowledged deletion.
    const jobs = await this.transaction(
      async (connection) =>
        (
          await connection.query<{
            workspace_id: string;
            conversation_id: string;
            message_id: string;
            actor_user_id: string;
          }>(
            `SELECT p.workspace_id,p.conversation_id,p.message_id,p.actor_user_id FROM message_purges p
              LEFT JOIN attachment_objects o ON o.workspace_id=p.workspace_id AND o.conversation_id=p.conversation_id AND o.message_id=p.message_id AND o.state<>'deleted'
              WHERE p.state='purging' AND o.id IS NULL ORDER BY p.requested_at,p.conversation_id,p.message_id LIMIT $1`,
            [limit],
          )
        ).rows,
    );
    for (const job of jobs)
      await this.transaction(async (connection) => {
        await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
          job.workspace_id,
        ]);
        await connection.query(
          'SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [job.workspace_id, job.conversation_id],
        );
        const current = (
          await connection.query<{ state: string }>(
            'SELECT state FROM message_purges WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3 FOR UPDATE',
            [job.workspace_id, job.conversation_id, job.message_id],
          )
        ).rows[0];
        if (current?.state !== 'purging') return;
        const remaining = await connection.query(
          "SELECT id FROM attachment_objects WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3 AND state<>'deleted' LIMIT 1",
          [job.workspace_id, job.conversation_id, job.message_id],
        );
        if (remaining.rows[0]) return;
        await connection.query('SELECT purge_conversation_message($1,$2,$3)', [
          job.workspace_id,
          job.conversation_id,
          job.message_id,
        ]);
        await connection.query(
          "UPDATE message_purges SET state='complete',completed_at=$4 WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3",
          [job.workspace_id, job.conversation_id, job.message_id, this.now()],
        );
        await connection.query(
          'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            randomUUID(),
            'conversation.message_purged',
            job.actor_user_id,
            this.now(),
            JSON.stringify({
              workspaceId: job.workspace_id,
              conversationId: job.conversation_id,
              messageId: job.message_id,
            }),
          ],
        );
      });
    return counts;
  }
  async readGroup(
    supplied: GroupBotAccess & { grantId: string },
    messageId: string,
    signal?: AbortSignal,
  ) {
    const access = Object.freeze({
      ...groupBotAccess(supplied.actorUserId, supplied.workspaceId, supplied.groupId),
      grantId: groupBotUuid(supplied.grantId),
    });
    const authorize = () =>
      this.transaction(async (connection) =>
        (await GroupBotTransaction.lock(connection, access)).attachmentMetadata(messageId),
      );
    const object = await authorize();
    return this.readAuthorizedObject(object, authorize, signal);
  }
  private async readAuthorizedObject(
    object: import('./types.js').AttachmentRow,
    authorize: () => Promise<import('./types.js').AttachmentRow>,
    signal?: AbortSignal,
  ) {
    if (object.backend_id !== this.store.identity) throw new AttachmentUnavailableError();
    const bytes = await this.store.read(
      { workspaceId: object.workspace_id, objectId: object.storage_id },
      object.bytes,
      signal,
    );
    if (
      bytes.length !== object.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== object.sha256
    )
      throw new AttachmentUnavailableError();
    const current = await authorize();
    if (current.id !== object.id || current.backend_id !== this.store.identity)
      throw new AttachmentUnavailableError();
    signal?.throwIfAborted();
    return { metadata: attachmentMetadata(object), bytes };
  }
  private async object(access: ConversationAccess, messageId: string) {
    return this.transaction(async (connection) =>
      (
        await ConversationTransaction.lock(connection, access, this.now, 'inspect')
      ).attachmentMetadata(messageId),
    );
  }
  async metadata(supplied: ConversationAccess, messageId: string) {
    return attachmentMetadata(
      await this.object(
        attachmentAccess(supplied.actorUserId, supplied.workspaceId, supplied.conversationId),
        messageId,
      ),
    );
  }
  async read(supplied: ConversationAccess, messageId: string, signal?: AbortSignal) {
    const access = attachmentAccess(
      supplied.actorUserId,
      supplied.workspaceId,
      supplied.conversationId,
    );
    return this.readAuthorizedObject(
      await this.object(access, messageId),
      () => this.object(access, messageId),
      signal,
    );
  }
}

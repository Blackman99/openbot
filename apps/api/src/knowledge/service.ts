import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import type { AttachmentService } from '../attachments/service.js';
import { lockAuthorizedBot } from '../bots/postgres-bot-access.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import type { ConversationAccess } from '../conversations/service.js';
import { ConversationAccessError } from '../conversations/service.js';
import { BotAccessError } from '../bots/service.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { GroupAccessError } from '../groups/service.js';
import { TEXT_KNOWLEDGE_EXTRACTOR_VERSION } from './text-extractor.js';
import {
  DOCUMENT_KNOWLEDGE_EXTRACTOR_VERSION,
  extractKnowledgeChunks,
} from './document-extractor.js';
import {
  IMAGE_KNOWLEDGE_EXTRACTOR_VERSION,
  classifyKnowledgeImage,
  imageKnowledgeChunk,
} from './image-knowledge.js';
import {
  KnowledgeAccessError,
  KnowledgeConflictError,
  KnowledgeInputError,
  knowledgeAccess,
  knowledgePromotionInput,
  knowledgeSearchInput,
  type KnowledgeDestination,
  type KnowledgePreview,
} from './types.js';
import { knowledgeMatchTerms } from './citation.js';
import { projectKnowledgeChunk, selectScopedKnowledgeChunks } from './run-context.js';

export class KnowledgeService {
  constructor(
    private readonly pool: SqlPool,
    private readonly attachments: AttachmentService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(
    supplied: ConversationAccess,
    messageId: string,
  ): Promise<{ preview: KnowledgePreview }> {
    const access = knowledgeAccess(
      supplied.actorUserId,
      supplied.workspaceId,
      supplied.conversationId,
    );
    const object = await this.attachments.read(access, messageId);
    if (classifyKnowledgeImage(object.metadata.filename, object.metadata.mediaType))
      return {
        preview: {
          source: {
            attachmentId: object.metadata.id,
            messageId,
            filename: object.metadata.filename,
            mediaType: object.metadata.mediaType,
            fileVersion: 1,
          },
          kind: 'image',
          chunks: [],
        },
      };
    const extraction = extractKnowledgeChunks({
      filename: object.metadata.filename,
      mediaType: object.metadata.mediaType,
      bytes: object.bytes,
      fileVersion: 1,
    });
    if (!extraction.ok) throw new KnowledgeInputError(extraction.error);
    return {
      preview: {
        source: {
          attachmentId: object.metadata.id,
          messageId,
          filename: object.metadata.filename,
          mediaType: object.metadata.mediaType,
          fileVersion: 1,
        },
        kind: extraction.kind,
        chunks: extraction.chunks,
      },
    };
  }

  async promote(supplied: ConversationAccess, messageId: string, input: unknown) {
    const access = knowledgeAccess(
      supplied.actorUserId,
      supplied.workspaceId,
      supplied.conversationId,
    );
    const command = knowledgePromotionInput(input);
    const object = await this.attachments.read(access, messageId);
    const image = classifyKnowledgeImage(object.metadata.filename, object.metadata.mediaType);
    if (image && (command.title === undefined || command.description === undefined))
      throw new KnowledgeInputError('image_description_required');
    const extraction = image
      ? {
          ok: true as const,
          kind: image,
          chunks: [imageKnowledgeChunk(command.title!, command.description!, 1)],
        }
      : extractKnowledgeChunks({
          filename: object.metadata.filename,
          mediaType: object.metadata.mediaType,
          bytes: object.bytes,
          fileVersion: 1,
        });
    if (!extraction.ok) throw new KnowledgeInputError(extraction.error);
    if (!image && (command.title !== undefined || command.description !== undefined))
      throw new KnowledgeInputError();
    return this.withAdmission(access, async (connection) => {
      await this.lockDestination(connection, access, command.destination);
      await ConversationTransaction.lock(connection, access, this.now, 'inspect');
      const attachment = (
        await connection.query<{
          id: string;
          filename: string;
          media_type: string;
          sha256: string;
          message_id: string | null;
          state: string;
        }>(
          `SELECT id,filename,media_type,sha256,message_id,state FROM attachment_objects
           WHERE workspace_id=$1 AND conversation_id=$2 AND message_id=$3 AND original_id IS NULL`,
          [access.workspaceId, access.conversationId, messageId],
        )
      ).rows[0];
      if (
        !attachment ||
        attachment.id !== object.metadata.id ||
        attachment.state !== 'live' ||
        attachment.filename !== object.metadata.filename ||
        attachment.media_type !== object.metadata.mediaType
      )
        throw new KnowledgeAccessError();
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            attachmentId: attachment.id,
            fileVersion: 1,
            sha256: attachment.sha256,
            destination: command.destination,
            ...(command.title !== undefined
              ? { title: command.title, description: command.description }
              : {}),
          }),
        )
        .digest('hex');
      const prior = (
        await connection.query<{
          id: string;
          command_hash: string;
          approved_at: Date;
          source_attachment_id: string;
        }>(
          `SELECT id,command_hash,approved_at,source_attachment_id
           FROM knowledge_documents
           WHERE workspace_id=$1 AND approver_user_id=$2 AND idempotency_key=$3`,
          [access.workspaceId, access.actorUserId, command.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.command_hash !== hash) throw new KnowledgeConflictError();
        const chunks = (
          await connection.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM knowledge_chunks WHERE document_id=$1',
            [prior.id],
          )
        ).rows[0];
        return {
          created: false,
          document: {
            id: prior.id,
            scope: {
              kind: command.destination.kind,
              id: command.destination.id,
              workspaceId: access.workspaceId,
            },
            source: {
              attachmentId: prior.source_attachment_id,
              messageId,
              filename: attachment.filename,
              fileVersion: Number(
                (
                  await connection.query<{ file_version: string | number }>(
                    'SELECT file_version FROM knowledge_documents WHERE id=$1',
                    [prior.id],
                  )
                ).rows[0]?.file_version ?? 1,
              ),
            },
            chunkCount: Number(chunks?.count ?? 0),
            approver: { id: access.actorUserId },
            approvedAt: prior.approved_at,
            replayed: true,
          },
        };
      }
      const fileVersion =
        Number(
          (
            await connection.query<{ file_version: string | number | null }>(
              `SELECT MAX(file_version) AS file_version FROM knowledge_documents
               WHERE workspace_id=$1 AND scope_kind=$2 AND scope_id=$3 AND filename=$4`,
              [
                access.workspaceId,
                command.destination.kind,
                command.destination.id,
                attachment.filename,
              ],
            )
          ).rows[0]?.file_version ?? 0,
        ) + 1;
      const documentId = randomUUID(),
        approvedAt = this.now();
      await connection.query(
        `INSERT INTO knowledge_documents(
          id,workspace_id,scope_kind,scope_id,source_attachment_id,source_conversation_id,source_message_id,
          file_version,filename,media_type,sha256,extractor_version,approver_user_id,approved_at,idempotency_key,command_hash
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          documentId,
          access.workspaceId,
          command.destination.kind,
          command.destination.id,
          attachment.id,
          access.conversationId,
          messageId,
          fileVersion,
          attachment.filename,
          attachment.media_type,
          attachment.sha256,
          extraction.kind === 'image'
            ? IMAGE_KNOWLEDGE_EXTRACTOR_VERSION
            : extraction.kind === 'pdf' || extraction.kind === 'docx' || extraction.kind === 'xlsx'
              ? DOCUMENT_KNOWLEDGE_EXTRACTOR_VERSION
              : TEXT_KNOWLEDGE_EXTRACTOR_VERSION,
          access.actorUserId,
          approvedAt,
          command.idempotencyKey,
          hash,
        ],
      );
      for (const [index, chunk] of extraction.chunks.entries()) {
        await connection.query(
          `INSERT INTO knowledge_chunks(
            id,document_id,position,file_version,locator_kind,locator_start,locator_end,text,locator_ref
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            documentId,
            index + 1,
            fileVersion,
            chunk.locator.kind,
            chunk.locator.start,
            chunk.locator.end,
            chunk.text,
            chunk.locator.ref ?? null,
          ],
        );
      }
      await connection.query(
        'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
        [
          randomUUID(),
          'knowledge.promoted',
          access.actorUserId,
          approvedAt,
          JSON.stringify({
            workspaceId: access.workspaceId,
            conversationId: access.conversationId,
            documentId,
            attachmentId: attachment.id,
            destinationKind: command.destination.kind,
            destinationId: command.destination.id,
          }),
        ],
      );
      return {
        created: true,
        document: {
          id: documentId,
          scope: {
            kind: command.destination.kind,
            id: command.destination.id,
            workspaceId: access.workspaceId,
          },
          source: {
            attachmentId: attachment.id,
            messageId,
            filename: attachment.filename,
            fileVersion,
          },
          chunkCount: extraction.chunks.length,
          approver: { id: access.actorUserId },
          approvedAt,
          replayed: false,
        },
      };
    });
  }

  async search(supplied: { actorUserId: string; workspaceId: string }, input: unknown) {
    const command = knowledgeSearchInput(input);
    return this.withAdmission(supplied, async (connection) => {
      try {
        await this.lockSearchScope(connection, supplied, command.scope);
      } catch (error) {
        if (
          error instanceof KnowledgeAccessError ||
          error instanceof ConversationAccessError ||
          error instanceof GroupAccessError ||
          error instanceof BotAccessError
        )
          return { chunks: [] };
        throw error;
      }
      const terms = knowledgeMatchTerms(command.query);
      if (!terms.length) return { chunks: [] };
      const rows = await selectScopedKnowledgeChunks(connection, {
        workspaceId: supplied.workspaceId,
        scopes: [command.scope],
        terms,
        limit: 50,
      });
      return { chunks: rows.map(projectKnowledgeChunk) };
    });
  }

  private async lockSearchScope(
    connection: SqlConnection,
    access: { actorUserId: string; workspaceId: string },
    destination: KnowledgeDestination,
  ) {
    if (destination.kind === 'workspace') {
      if (destination.id !== access.workspaceId) throw new KnowledgeAccessError();
      return;
    }
    if (destination.kind === 'group') {
      await lockAuthorizedGroup(
        connection,
        {
          actorId: access.actorUserId,
          workspaceId: access.workspaceId,
          groupId: destination.id,
        },
        'content',
      );
      return;
    }
    const bot = await lockAuthorizedBot(
      connection,
      {
        actorUserId: access.actorUserId,
        workspaceId: access.workspaceId,
        botId: destination.id,
      },
      'inspect',
    );
    if (bot.lifecycle_state === 'deleted') throw new KnowledgeAccessError();
  }

  private async lockDestination(
    connection: SqlConnection,
    access: ConversationAccess,
    destination: KnowledgeDestination,
  ) {
    if (destination.kind === 'workspace') {
      if (destination.id !== access.workspaceId) throw new KnowledgeAccessError();
      const role = (
        await connection.query<{ role: string }>(
          "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','administrator')",
          [access.workspaceId, access.actorUserId],
        )
      ).rows[0];
      if (!role) throw new KnowledgeAccessError();
      return;
    }
    if (destination.kind === 'group') {
      await lockAuthorizedGroup(
        connection,
        {
          actorId: access.actorUserId,
          workspaceId: access.workspaceId,
          groupId: destination.id,
        },
        'content',
      );
      return;
    }
    const bot = await lockAuthorizedBot(
      connection,
      {
        actorUserId: access.actorUserId,
        workspaceId: access.workspaceId,
        botId: destination.id,
      },
      'edit',
    );
    if (bot.lifecycle_state === 'deleted') throw new KnowledgeAccessError();
  }

  private async withAdmission<T>(
    access: { actorUserId: string; workspaceId: string },
    action: (connection: SqlConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
        access.workspaceId,
      ]);
      const member = (
        await connection.query(
          'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
          [access.workspaceId, access.actorUserId],
        )
      ).rows[0];
      if (!member) throw new KnowledgeAccessError();
      const value = await action(connection);
      await connection.query('COMMIT');
      return value;
    } catch (error) {
      await connection.query('ROLLBACK');
      if (
        error instanceof ConversationAccessError ||
        error instanceof GroupAccessError ||
        error instanceof BotAccessError
      )
        throw new KnowledgeAccessError();
      throw error;
    } finally {
      connection.release();
    }
  }
}

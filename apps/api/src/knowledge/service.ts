import { createHash, randomUUID } from 'node:crypto';
import type { AttachmentService } from '../attachments/service.js';
import type { AttachmentRow } from '../attachments/types.js';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedBot } from '../bots/postgres-bot-access.js';
import { BotAccessError } from '../bots/service.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { ConversationAccessError, type ConversationAccess } from '../conversations/service.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { GroupAccessError } from '../groups/service.js';
import {
  extractTextKnowledgeChunks,
  TEXT_KNOWLEDGE_EXTRACTOR_VERSION,
  type KnowledgeExtraction,
} from './text-extractor.js';
import {
  KnowledgeAccessError,
  KnowledgeConflictError,
  KnowledgeInputError,
  knowledgeAccess,
  knowledgeConfirmInput,
  knowledgePreviewInput,
  type KnowledgeDocument,
  type KnowledgePreview,
  type KnowledgeScope,
} from './types.js';

const PREVIEW_TTL_MS = 5 * 60 * 1000;

function accessDenied(error: unknown) {
  return (
    error instanceof KnowledgeAccessError ||
    error instanceof ConversationAccessError ||
    error instanceof GroupAccessError ||
    error instanceof BotAccessError
  );
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

function extractionHash(extraction: Extract<KnowledgeExtraction, { ok: true }>) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        extractorVersion: TEXT_KNOWLEDGE_EXTRACTOR_VERSION,
        kind: extraction.kind,
        chunks: extraction.chunks,
      }),
    )
    .digest('hex');
}

function confirmCommandHash(
  messageId: string,
  command: { intentId: string; idempotencyKey: string },
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: 'knowledge.promote',
        messageId,
        intentId: command.intentId,
        idempotencyKey: command.idempotencyKey,
      }),
    )
    .digest('hex');
}

type IntentRow = {
  id: string;
  source_attachment_id: string;
  file_version: number;
  filename: string;
  media_type: string;
  sha256: string;
  extractor_version: string;
  content_hash: string;
  destination_scope_kind: KnowledgeScope['kind'];
  destination_scope_id: string;
  expires_at: Date;
};

type DocumentRow = {
  id: string;
  scope_kind: KnowledgeScope['kind'];
  scope_id: string;
  source_attachment_id: string;
  source_message_id: string;
  filename: string;
  media_type: string;
  file_version: number;
  extractor_version: string;
  approver_user_id: string;
  approved_at: Date;
};

export class KnowledgeService {
  constructor(
    private readonly pool: SqlPool,
    private readonly attachments: AttachmentService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async transaction<T>(action: (connection: SqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await action(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  private async auditDenial(
    connection: SqlConnection,
    access: ConversationAccess,
    operation: 'preview' | 'confirm',
    refs: { messageId?: string; intentId?: string } = {},
  ) {
    await connection.query(
      'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
      [
        randomUUID(),
        'knowledge.access_denied',
        access.actorUserId,
        this.now(),
        JSON.stringify({
          operation,
          workspaceId: access.workspaceId,
          conversationId: access.conversationId,
          ...refs,
        }),
      ],
    );
  }

  private async admitted<T>(
    access: ConversationAccess,
    operation: 'preview' | 'confirm',
    refs: { messageId?: string; intentId?: string },
    action: (connection: SqlConnection) => Promise<T>,
  ): Promise<T> {
    const result = await this.transaction(async (connection) => {
      try {
        return { allowed: true as const, value: await action(connection) };
      } catch (error) {
        if (!accessDenied(error)) throw error;
        await this.auditDenial(connection, access, operation, refs);
        return { allowed: false as const };
      }
    });
    if (!result.allowed) throw new KnowledgeAccessError();
    return result.value;
  }

  private async lockScope(
    connection: SqlConnection,
    access: ConversationAccess,
    scope: KnowledgeScope,
  ) {
    const conversation = (
      await connection.query<{ group_id: string | null }>(
        'SELECT group_id FROM conversations WHERE workspace_id=$1 AND id=$2',
        [access.workspaceId, access.conversationId],
      )
    ).rows[0];
    if (!conversation) throw new KnowledgeAccessError();
    const groups = [
      ...new Set(
        [conversation.group_id, scope.kind === 'group' ? scope.id : null].filter(
          (id): id is string => id != null,
        ),
      ),
    ].sort();
    for (const groupId of groups)
      await lockAuthorizedGroup(
        connection,
        { actorId: access.actorUserId, workspaceId: access.workspaceId, groupId },
        'content',
      );
    if (scope.kind === 'bot') {
      const bot = await lockAuthorizedBot(
        connection,
        {
          actorUserId: access.actorUserId,
          workspaceId: access.workspaceId,
          botId: scope.id,
        },
        'edit',
      );
      if (bot.lifecycle_state === 'deleted') throw new KnowledgeAccessError();
    }
    if (scope.kind === 'workspace') {
      if (scope.id !== access.workspaceId) throw new KnowledgeAccessError();
      const role = (
        await connection.query<{ role: string }>(
          "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','administrator')",
          [access.workspaceId, access.actorUserId],
        )
      ).rows[0];
      if (!role) throw new KnowledgeAccessError();
    }
    return ConversationTransaction.lock(connection, access, this.now, 'inspect');
  }

  private async extract(access: ConversationAccess, messageId: string) {
    const object = await this.attachments.read(access, messageId);
    const sha256 = createHash('sha256').update(object.bytes).digest('hex');
    const extraction = extractTextKnowledgeChunks({
      filename: object.metadata.filename,
      mediaType: object.metadata.mediaType,
      bytes: object.bytes,
      fileVersion: 1,
    });
    if (!extraction.ok) throw new KnowledgeInputError(extraction.error);
    return { object, sha256, extraction };
  }

  private previewPayload(
    messageId: string,
    attachmentId: string,
    filename: string,
    mediaType: string,
    extraction: Extract<KnowledgeExtraction, { ok: true }>,
    bound?: { id: string; expiresAt: Date; scope: KnowledgeScope },
  ): { preview: KnowledgePreview } {
    return {
      preview: {
        ...(bound ?? {}),
        source: {
          attachmentId,
          messageId,
          filename,
          mediaType,
          fileVersion: 1,
        },
        kind: extraction.kind,
        chunks: extraction.chunks,
      },
    };
  }

  async preview(
    supplied: ConversationAccess,
    messageId: string,
    input: unknown = {},
  ): Promise<{ preview: KnowledgePreview }> {
    const access = knowledgeAccess(
      supplied.actorUserId,
      supplied.workspaceId,
      supplied.conversationId,
    );
    const scope = knowledgePreviewInput(input);
    const { object, sha256, extraction } = await this.extract(access, messageId);
    if (!scope)
      return this.previewPayload(
        messageId,
        object.metadata.id,
        object.metadata.filename,
        object.metadata.mediaType,
        extraction,
      );
    return this.admitted(access, 'preview', { messageId }, async (connection) => {
      const admitted = await this.lockScope(connection, access, scope);
      const current = await admitted.attachmentMetadata(messageId);
      if (
        current.id !== object.metadata.id ||
        current.filename !== object.metadata.filename ||
        current.media_type !== object.metadata.mediaType ||
        current.sha256 !== sha256
      )
        throw new KnowledgeAccessError();
      const createdAt = this.now(),
        expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS),
        intentId = randomUUID();
      await connection.query(
        `INSERT INTO knowledge_promotion_intents(
          id,workspace_id,actor_user_id,conversation_id,source_message_id,source_attachment_id,file_version,filename,media_type,sha256,extractor_version,content_hash,destination_scope_kind,destination_scope_id,expires_at,created_at
        ) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          intentId,
          access.workspaceId,
          access.actorUserId,
          access.conversationId,
          messageId,
          current.id,
          current.filename,
          current.media_type,
          current.sha256,
          TEXT_KNOWLEDGE_EXTRACTOR_VERSION,
          extractionHash(extraction),
          scope.kind,
          scope.id,
          expiresAt,
          createdAt,
        ],
      );
      return this.previewPayload(
        messageId,
        current.id,
        current.filename,
        current.media_type,
        extraction,
        { id: intentId, expiresAt, scope },
      );
    });
  }

  async confirm(supplied: ConversationAccess, messageId: string, input: unknown) {
    const access = knowledgeAccess(
      supplied.actorUserId,
      supplied.workspaceId,
      supplied.conversationId,
    );
    const command = knowledgeConfirmInput(input);
    const hash = confirmCommandHash(messageId, command);
    const { object, sha256, extraction } = await this.extract(access, messageId);
    return this.admitted(
      access,
      'confirm',
      { messageId, intentId: command.intentId },
      async (connection) => {
        const prior = (
          await connection.query<DocumentRow>(
            `SELECT id,scope_kind,scope_id,source_attachment_id,source_message_id,filename,media_type,file_version,extractor_version,approver_user_id,approved_at
             FROM knowledge_documents
             WHERE workspace_id=$1 AND approver_user_id=$2 AND idempotency_key=$3`,
            [access.workspaceId, access.actorUserId, command.idempotencyKey],
          )
        ).rows[0];
        if (prior) {
          const stored = (
            await connection.query<{ command_hash: string }>(
              'SELECT command_hash FROM knowledge_documents WHERE id=$1',
              [prior.id],
            )
          ).rows[0];
          if (stored?.command_hash !== hash)
            throw new KnowledgeConflictError('idempotency_conflict');
          return {
            document: await this.projectDocument(connection, prior, extraction),
            replayed: true,
          };
        }
        const intent = (
          await connection.query<IntentRow>(
            `SELECT id,source_attachment_id,file_version,filename,media_type,sha256,extractor_version,content_hash,destination_scope_kind,destination_scope_id,expires_at
             FROM knowledge_promotion_intents
             WHERE id=$1 AND workspace_id=$2 AND actor_user_id=$3 AND conversation_id=$4 AND source_message_id=$5`,
            [
              command.intentId,
              access.workspaceId,
              access.actorUserId,
              access.conversationId,
              messageId,
            ],
          )
        ).rows[0];
        if (!intent || timestamp(intent.expires_at) <= this.now().getTime())
          throw new KnowledgeAccessError();
        const scope = {
          kind: intent.destination_scope_kind,
          id: intent.destination_scope_id,
        };
        const admitted = await this.lockScope(connection, access, scope);
        const row: AttachmentRow = await admitted.attachmentMetadata(messageId);
        if (
          row.id !== intent.source_attachment_id ||
          row.id !== object.metadata.id ||
          row.filename !== intent.filename ||
          row.media_type !== intent.media_type ||
          row.sha256 !== intent.sha256 ||
          row.sha256 !== sha256 ||
          intent.extractor_version !== TEXT_KNOWLEDGE_EXTRACTOR_VERSION ||
          Number(intent.file_version) !== 1 ||
          intent.content_hash !== extractionHash(extraction)
        )
          throw new KnowledgeAccessError();
        const consumed = (
          await connection.query<{ document_id: string }>(
            'SELECT document_id FROM knowledge_promotion_confirmations WHERE intent_id=$1',
            [intent.id],
          )
        ).rows[0];
        if (consumed) {
          const existing = (
            await connection.query<DocumentRow>(
              `SELECT id,scope_kind,scope_id,source_attachment_id,source_message_id,filename,media_type,file_version,extractor_version,approver_user_id,approved_at
               FROM knowledge_documents WHERE id=$1`,
              [consumed.document_id],
            )
          ).rows[0];
          if (!existing) throw new KnowledgeAccessError();
          return {
            document: await this.projectDocument(connection, existing, extraction),
            replayed: true,
          };
        }
        const approvedAt = this.now(),
          documentId = randomUUID();
        await connection.query(
          `INSERT INTO knowledge_documents(
            id,workspace_id,scope_kind,scope_id,source_attachment_id,source_conversation_id,source_message_id,file_version,filename,media_type,sha256,extractor_version,approver_user_id,approved_at,idempotency_key,command_hash
          ) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            documentId,
            access.workspaceId,
            scope.kind,
            scope.id,
            row.id,
            access.conversationId,
            messageId,
            row.filename,
            row.media_type,
            row.sha256,
            TEXT_KNOWLEDGE_EXTRACTOR_VERSION,
            access.actorUserId,
            approvedAt,
            command.idempotencyKey,
            hash,
          ],
        );
        for (const [index, chunk] of extraction.chunks.entries()) {
          await connection.query(
            `INSERT INTO knowledge_chunks(
              id,document_id,position,file_version,locator_kind,locator_start,locator_end,text
            ) VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
            [
              randomUUID(),
              documentId,
              index + 1,
              chunk.locator.kind,
              chunk.locator.start,
              chunk.locator.end,
              chunk.text,
            ],
          );
        }
        await connection.query(
          'INSERT INTO knowledge_promotion_confirmations(intent_id,document_id,confirmed_at) VALUES($1,$2,$3)',
          [intent.id, documentId, approvedAt],
        );
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
              messageId,
              documentId,
              intentId: intent.id,
              scopeKind: scope.kind,
              scopeId: scope.id,
            }),
          ],
        );
        const created = (
          await connection.query<DocumentRow>(
            `SELECT id,scope_kind,scope_id,source_attachment_id,source_message_id,filename,media_type,file_version,extractor_version,approver_user_id,approved_at
             FROM knowledge_documents WHERE id=$1`,
            [documentId],
          )
        ).rows[0];
        if (!created) throw new Error('Knowledge publication failed');
        return {
          document: await this.projectDocument(connection, created, extraction),
          replayed: false,
        };
      },
    );
  }

  private async projectDocument(
    connection: SqlConnection,
    row: DocumentRow,
    extraction: Extract<KnowledgeExtraction, { ok: true }>,
  ): Promise<KnowledgeDocument> {
    const chunks = (
      await connection.query<{
        position: number;
        file_version: number;
        locator_kind: 'line' | 'row';
        locator_start: number;
        locator_end: number;
        text: string;
      }>(
        'SELECT position,file_version,locator_kind,locator_start,locator_end,text FROM knowledge_chunks WHERE document_id=$1 ORDER BY position',
        [row.id],
      )
    ).rows;
    return {
      id: row.id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      source: {
        attachmentId: row.source_attachment_id,
        messageId: row.source_message_id,
        filename: row.filename,
        mediaType: row.media_type,
        fileVersion: Number(row.file_version),
      },
      kind: extraction.kind,
      extractorVersion: row.extractor_version,
      approver: { id: row.approver_user_id },
      approvedAt: row.approved_at,
      chunks: chunks.map((chunk) => ({
        position: Number(chunk.position),
        text: chunk.text,
        fileVersion: Number(chunk.file_version),
        locator: {
          kind: chunk.locator_kind,
          start: Number(chunk.locator_start),
          end: Number(chunk.locator_end),
        },
      })),
    };
  }
}

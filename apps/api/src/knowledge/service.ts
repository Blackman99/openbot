import type { AttachmentService } from '../attachments/service.js';
import type { ConversationAccess } from '../conversations/service.js';
import { extractTextKnowledgeChunks } from './text-extractor.js';
import { KnowledgeInputError, knowledgeAccess, type KnowledgePreview } from './types.js';

export class KnowledgeService {
  constructor(private readonly attachments: AttachmentService) {}

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
    const extraction = extractTextKnowledgeChunks({
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
}

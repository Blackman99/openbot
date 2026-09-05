import { createHash } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { LOCAL_EXTRACTOR_VERSION, LOCAL_NORMALIZER_VERSION } from './extraction-schema.js';
import type { RunMemoryContribution } from './run-context.js';

export type SourceManifestItem = {
  kind: 'bot_instructions' | 'message' | 'group_memory' | 'bot_private_memory';
  workspaceId: string;
  conversationId?: string;
  botVersionId?: string;
  messageId?: string;
  creationEventId?: string;
  creationSequence?: number;
  versionEventId?: string;
  memoryVersionId?: string;
  privateMemoryId?: string;
  sourceEventId?: string;
  role?: 'user' | 'assistant' | 'system';
};

export function sourceManifestDigest(items: readonly SourceManifestItem[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        items.map((item, index) => ({
          position: index + 1,
          kind: item.kind,
          workspaceId: item.workspaceId,
          conversationId: item.conversationId ?? null,
          botVersionId: item.botVersionId ?? null,
          messageId: item.messageId ?? null,
          creationEventId: item.creationEventId ?? null,
          creationSequence: item.creationSequence ?? null,
          versionEventId: item.versionEventId ?? null,
          memoryVersionId: item.memoryVersionId ?? null,
          privateMemoryId: item.privateMemoryId ?? null,
          sourceEventId: item.sourceEventId ?? null,
          role: item.role ?? null,
        })),
      ),
    )
    .digest('hex');
}

export async function persistRunSourceManifest(
  connection: SqlConnection,
  input: {
    runId: string;
    workspaceId: string;
    conversationId: string;
    botVersionId: string;
    memory: RunMemoryContribution;
    messages: ReadonlyArray<{
      id: string;
      creationSequence: number;
      versionEventId: string;
      role: 'user' | 'assistant';
    }>;
    now: Date;
  },
): Promise<string> {
  const items: SourceManifestItem[] = [
    {
      kind: 'bot_instructions',
      workspaceId: input.workspaceId,
      botVersionId: input.botVersionId,
    },
  ];
  for (const reference of input.memory.references) {
    items.push(
      reference.kind === 'group'
        ? {
            kind: 'group_memory',
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            memoryVersionId: reference.memoryVersionId,
            sourceEventId: reference.sourceEventId,
          }
        : {
            kind: 'bot_private_memory',
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            privateMemoryId: reference.privateMemoryId,
            sourceEventId: reference.sourceEventId,
          },
    );
  }
  const creations = input.messages.length
    ? (
        await connection.query<{ id: string; message_id: string }>(
          `SELECT id,message_id FROM conversation_events WHERE conversation_id=$1 AND message_id IN (${input.messages.map((_, index) => `$${index + 2}`).join(',')}) AND event_type IN ('message.created','bot.message.created')`,
          [input.conversationId, ...input.messages.map((message) => message.id)],
        )
      ).rows
    : [];
  const creationByMessage = new Map(creations.map((row) => [row.message_id, row.id]));
  for (const message of input.messages) {
    const creationEventId = creationByMessage.get(message.id);
    if (!creationEventId) continue;
    items.push({
      kind: 'message',
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      messageId: message.id,
      creationEventId,
      creationSequence: message.creationSequence,
      versionEventId: message.versionEventId,
      role: message.role,
    });
  }
  const digest = sourceManifestDigest(items);
  await connection.query(
    'INSERT INTO run_source_manifests(run_id,digest,created_at) VALUES($1,$2,$3)',
    [input.runId, digest, input.now],
  );
  for (const [index, item] of items.entries()) {
    await connection.query(
      `INSERT INTO run_source_manifest_items(
        run_id,position,kind,workspace_id,conversation_id,bot_version_id,message_id,creation_event_id,creation_sequence,version_event_id,memory_version_id,private_memory_id,source_event_id,role
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        input.runId,
        index + 1,
        item.kind,
        item.workspaceId,
        item.conversationId ?? null,
        item.botVersionId ?? null,
        item.messageId ?? null,
        item.creationEventId ?? null,
        item.creationSequence ?? null,
        item.versionEventId ?? null,
        item.memoryVersionId ?? null,
        item.privateMemoryId ?? null,
        item.sourceEventId ?? null,
        item.role ?? null,
      ],
    );
  }
  return digest;
}

export async function enqueueMemoryExtractionJob(
  connection: SqlConnection,
  input: { runId: string; outputEventId: string; digest: string; now: Date },
) {
  await connection.query(
    `INSERT INTO memory_extraction_jobs(
      run_id,output_event_id,manifest_digest,status,extractor_version,normalizer_version,attempt_count,available_at,created_at,updated_at
    ) VALUES($1,$2,$3,'queued',$4,$5,0,$6,$6,$6)`,
    [
      input.runId,
      input.outputEventId,
      input.digest,
      LOCAL_EXTRACTOR_VERSION,
      LOCAL_NORMALIZER_VERSION,
      input.now,
    ],
  );
}

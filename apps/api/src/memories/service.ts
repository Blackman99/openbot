import {
  memoryRowColumns,
  memoryRowTables,
  projectCurrentMemory,
  privateMemoryCurrentFrom,
  privateMemoryCurrentWhere,
  privateMemoryRowColumns,
  projectPrivateMemory,
  selectCurrentMemoryRows,
  selectCurrentPrivateMemoryRows,
  type PrivateMemoryRow,
} from './current.js';
import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { GroupAccessError } from '../groups/service.js';
import { GroupBotTransaction } from '../group-bots/postgres-admission.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { BotAccessError } from '../bots/service.js';
import { lockAuthorizedBot } from '../bots/postgres-bot-access.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { ConversationAccessError } from '../conversations/service.js';
import type { CurrentMessageSource } from '../conversations/message-source.js';
import {
  BOT_PRIVATE_VISIBILITY_SUMMARY,
  MemoryAccessError,
  MemoryConflictError,
  MemoryInputError,
  candidateAccess,
  candidateApproveInput,
  candidateEditInput,
  candidatePreviewInput,
  candidateRejectInput,
  memoryAccess,
  memoryCommand,
  memoryCommandHash,
  memoryRead,
  memoryUuid,
  privateMemoryAccess,
  promotionConfirmInput,
  promotionPreviewInput,
  type ApprovedFact,
  type CandidateAccess,
  type MemoryAccess,
  type MemoryCandidate,
  type MemoryProjection,
  type MemoryPromotionPreview,
  type MemoryRow,
  type PrivateMemoryAccess,
  type PrivateMemoryProjection,
} from './types.js';
import {
  PREVIEW_TTL_MS as REVIEW_PREVIEW_TTL_MS,
  REVIEW_DISCLOSURE_VERSION,
  candidateLineageDigest,
  destinationAudience,
  insertDecision,
  loadCandidate,
  lockCandidateRow,
  lockReviewScopes,
  lockWorkspaceMember,
  projectApprovedFact,
  projectCandidate,
  publishApprovedFact,
  replayDecision,
  requiresSeparateConfirmation,
  reviewCommandHash,
  selectApprovedFactRows,
  textHash as reviewTextHash,
} from './review.js';

type Admission = {
  conversationId?: string;
  lowerBound: number;
  source(messageId: string): Promise<CurrentMessageSource>;
};
type Operation =
  | 'create'
  | 'read'
  | 'list'
  | 'search'
  | 'preview'
  | 'promote'
  | 'list-private'
  | 'search-private'
  | 'read-private'
  | 'list-candidates'
  | 'edit-candidate'
  | 'reject-candidate'
  | 'approve-candidate'
  | 'preview-candidate'
  | 'confirm-candidate';
const PREVIEW_TTL_MS = 5 * 60 * 1000;
function accessDenied(error: unknown) {
  return (
    error instanceof MemoryAccessError ||
    error instanceof ConversationAccessError ||
    error instanceof GroupAccessError ||
    error instanceof GroupBotAccessError ||
    error instanceof BotAccessError
  );
}

export class MemoryService {
  constructor(
    private readonly pool: SqlPool,
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
    access: MemoryAccess,
    operation: Operation,
    refs: {
      messageId?: string;
      memoryId?: string;
      botId?: string;
      conversationId?: string;
      candidateId?: string;
    } = {},
  ) {
    await connection.query(
      'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
      [
        randomUUID(),
        'memory.access_denied',
        access.actorUserId,
        this.now(),
        JSON.stringify({
          operation,
          workspaceId: access.workspaceId,
          groupId: access.groupId,
          ...(access.grantId ? { grantId: access.grantId } : {}),
          ...refs,
        }),
      ],
    );
  }
  private async admitted<T>(
    access: MemoryAccess,
    operation: Operation,
    refs: { messageId?: string; memoryId?: string; botId?: string },
    action: (connection: SqlConnection, admitted: Admission) => Promise<T>,
  ): Promise<T> {
    const result = await this.transaction(async (connection) => {
      try {
        return {
          allowed: true as const,
          value: await action(connection, await this.lock(connection, access)),
        };
      } catch (error) {
        if (!accessDenied(error)) throw error;
        // Authorization failures happen before content mutations. Commit their
        // mandatory audit before the HTTP boundary maps the outcome to 403.
        await this.auditDenial(connection, access, operation, refs);
        return { allowed: false as const };
      }
    });
    if (!result.allowed) throw new MemoryAccessError();
    return result.value;
  }
  private async lock(connection: SqlConnection, access: MemoryAccess): Promise<Admission> {
    if (access.grantId) {
      const grant = await GroupBotTransaction.lock(connection, {
        ...access,
        grantId: access.grantId,
      });
      const bounds = (
        await connection.query<{ conversation_id: string; lower_bound: string | number }>(
          'SELECT conversation_id,lower_bound FROM group_bot_grants WHERE workspace_id=$1 AND group_id=$2 AND id=$3 AND close_event_id IS NULL',
          [access.workspaceId, access.groupId, access.grantId],
        )
      ).rows[0];
      if (!bounds) throw new MemoryAccessError();
      return {
        conversationId: bounds.conversation_id,
        lowerBound: Number(bounds.lower_bound),
        source: (id) => grant.sourceForMemory(id),
      };
    }
    await lockAuthorizedGroup(
      connection,
      { actorId: access.actorUserId, workspaceId: access.workspaceId, groupId: access.groupId },
      'content',
    );
    const row = (
      await connection.query<{ id: string }>(
        'SELECT id FROM conversations WHERE workspace_id=$1 AND group_id=$2',
        [access.workspaceId, access.groupId],
      )
    ).rows[0];
    if (!row)
      return {
        lowerBound: 1,
        source: async () => {
          throw new MemoryAccessError();
        },
      };
    const conversation = await ConversationTransaction.lock(
      connection,
      { actorUserId: access.actorUserId, workspaceId: access.workspaceId, conversationId: row.id },
      this.now,
      'inspect',
    );
    return {
      conversationId: row.id,
      lowerBound: 1,
      source: (id) => conversation.sourceForMemory(id),
    };
  }
  private async row(connection: SqlConnection, access: MemoryAccess, memoryId: string) {
    return (
      await connection.query<MemoryRow>(
        `SELECT ${memoryRowColumns} FROM ${memoryRowTables} WHERE m.workspace_id=$1 AND m.group_id=$2 AND m.id=$3`,
        [access.workspaceId, access.groupId, memoryId],
      )
    ).rows[0];
  }
  private async visible(row: MemoryRow | undefined, admitted: Admission) {
    if (!row || row.conversation_id !== admitted.conversationId) throw new MemoryAccessError();
    const source = await admitted.source(row.source_message_id);
    return projectCurrentMemory(row, source);
  }
  async deny(supplied: MemoryAccess, operation: Operation) {
    const access = memoryAccess(supplied);
    await this.transaction((connection) => this.auditDenial(connection, access, operation));
    throw new MemoryAccessError();
  }
  async create(supplied: MemoryAccess, input: unknown) {
    const access = memoryAccess(supplied),
      command = memoryCommand(input);
    return this.admitted(
      access,
      'create',
      { messageId: command.messageId },
      async (connection, admitted) => {
        if (access.grantId) throw new MemoryAccessError();
        const hash = memoryCommandHash(command);
        const prior = (
          await connection.query<MemoryRow>(
            `SELECT ${memoryRowColumns} FROM ${memoryRowTables} WHERE m.workspace_id=$1 AND m.group_id=$2 AND m.creator_user_id=$3 AND m.idempotency_key=$4`,
            [access.workspaceId, access.groupId, access.actorUserId, command.idempotencyKey],
          )
        ).rows[0];
        if (prior) {
          if (prior.command_hash !== hash) throw new MemoryConflictError('idempotency_conflict');
          return { memory: await this.visible(prior, admitted), replayed: true };
        }
        const source = await admitted.source(command.messageId);
        if (source.versionEventId !== command.expectedSourceEventId)
          throw new MemoryConflictError('source_version_conflict');
        const id = randomUUID(),
          versionId = randomUUID(),
          createdAt = this.now();
        await connection.query(
          'INSERT INTO group_memories(id,workspace_id,group_id,conversation_id,creator_user_id,created_at,idempotency_key,command_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id,
            access.workspaceId,
            access.groupId,
            source.conversationId,
            access.actorUserId,
            createdAt,
            command.idempotencyKey,
            hash,
          ],
        );
        await connection.query(
          'INSERT INTO memory_versions(id,memory_id,version,source_message_id,source_event_id,source_creation_event_id,source_creation_sequence,confidence) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
          [
            versionId,
            id,
            source.messageId,
            source.versionEventId,
            source.creationEventId,
            source.creationSequence,
            command.confidence,
          ],
        );
        await connection.query(
          'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            randomUUID(),
            'memory.created',
            access.actorUserId,
            createdAt,
            JSON.stringify({
              workspaceId: access.workspaceId,
              groupId: access.groupId,
              memoryId: id,
              versionId,
              sourceEventId: source.versionEventId,
            }),
          ],
        );
        const row = await this.row(connection, access, id);
        if (!row) throw new Error('Memory publication failed');
        return { memory: projectCurrentMemory(row, source), replayed: false };
      },
    );
  }
  async get(supplied: MemoryAccess, id: string): Promise<MemoryProjection> {
    const access = memoryAccess(supplied),
      memoryId = memoryUuid(id);
    return this.admitted(access, 'read', { memoryId }, async (connection, admitted) =>
      this.visible(await this.row(connection, access, memoryId), admitted),
    );
  }
  async list(supplied: MemoryAccess, input: unknown, search = false) {
    const access = memoryAccess(supplied),
      read = memoryRead(input, search);
    return this.admitted(access, search ? 'search' : 'list', {}, async (connection, admitted) => {
      if (!admitted.conversationId) return { memories: [], nextAfter: null };
      const rows = await selectCurrentMemoryRows(
        connection,
        {
          workspaceId: access.workspaceId,
          groupId: access.groupId,
          conversationId: admitted.conversationId,
          lowerBound: admitted.lowerBound,
        },
        { ...read, limit: read.limit + 1 },
      );
      const memories: Array<MemoryProjection | ApprovedFact> = [];
      for (const row of rows) memories.push(await this.visible(row, admitted));
      const facts = (
        await selectApprovedFactRows(connection, {
          workspaceId: access.workspaceId,
          groupId: access.groupId,
          includeWorkspace: true,
          ...(read.query ? { query: read.query } : {}),
          ...(read.after ? { after: read.after } : {}),
          limit: read.limit + 1,
        })
      ).map(projectApprovedFact);
      const merged = [...memories, ...facts].sort((left, right) => (left.id < right.id ? -1 : 1));
      const page = merged.slice(0, read.limit);
      return { memories: page, nextAfter: merged.length > read.limit ? page.at(-1)!.id : null };
    });
  }
  async preview(
    supplied: MemoryAccess,
    id: string,
    input: unknown,
  ): Promise<{ preview: MemoryPromotionPreview }> {
    const access = memoryAccess(supplied),
      memoryId = memoryUuid(id),
      requested = promotionPreviewInput(input);
    return this.admitted(
      access,
      'preview',
      { memoryId, botId: requested.destinationBotId },
      async (connection, admitted) => {
        if (access.grantId) throw new MemoryAccessError();
        const visible = await this.visible(await this.row(connection, access, memoryId), admitted);
        const destination = await lockAuthorizedBot(
          connection,
          {
            actorUserId: access.actorUserId,
            workspaceId: access.workspaceId,
            botId: requested.destinationBotId,
          },
          'edit',
        );
        const lineage = lineageDigest(visible);
        const contentHash = textHash(visible.text);
        const createdAt = this.now(),
          expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS),
          intentId = randomUUID();
        await connection.query(
          'INSERT INTO memory_promotion_intents(id,workspace_id,actor_user_id,source_group_id,source_memory_id,destination_bot_id,content_hash,lineage_digest,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            intentId,
            access.workspaceId,
            access.actorUserId,
            access.groupId,
            memoryId,
            destination.id,
            contentHash,
            lineage,
            expiresAt,
            createdAt,
          ],
        );
        return {
          preview: {
            id: intentId,
            expiresAt,
            source: {
              groupId: access.groupId,
              groupName: (
                await connection.query<{ name: string }>('SELECT name FROM groups WHERE id=$1', [
                  access.groupId,
                ])
              ).rows[0]!.name,
              memoryId,
              text: visible.text,
            },
            destinationBot: { id: destination.id, name: destination.configuration.name },
            visibility: {
              kind: 'bot-private',
              botId: destination.id,
              summary: BOT_PRIVATE_VISIBILITY_SUMMARY,
            },
            content: visible.text,
          },
        };
      },
    );
  }
  async confirm(supplied: MemoryAccess, id: string, input: unknown) {
    const access = memoryAccess(supplied),
      memoryId = memoryUuid(id),
      command = promotionConfirmInput(input);
    return this.admitted(
      access,
      'promote',
      { memoryId, botId: command.intentId },
      async (connection, admitted) => {
        if (access.grantId) throw new MemoryAccessError();
        const hash = promotionCommandHash(memoryId, command);
        const prior = (
          await connection.query<PrivateMemoryRow>(
            `SELECT ${privateMemoryRowColumns} FROM ${privateMemoryCurrentFrom} WHERE ${privateMemoryCurrentWhere} AND p.approver_user_id=$1 AND p.idempotency_key=$2`,
            [access.actorUserId, command.idempotencyKey],
          )
        ).rows[0];
        if (prior) {
          const stored = (
            await connection.query<{ command_hash: string }>(
              'SELECT command_hash FROM bot_private_memories WHERE id=$1',
              [prior.id],
            )
          ).rows[0];
          if (stored?.command_hash !== hash) throw new MemoryConflictError('idempotency_conflict');
          return { memory: projectPrivateMemory(prior), replayed: true };
        }
        const visible = await this.visible(await this.row(connection, access, memoryId), admitted);
        const intent = (
          await connection.query<{
            id: string;
            destination_bot_id: string;
            content_hash: string;
            lineage_digest: string;
            expires_at: Date;
          }>(
            'SELECT id,destination_bot_id,content_hash,lineage_digest,expires_at FROM memory_promotion_intents WHERE id=$1 AND workspace_id=$2 AND actor_user_id=$3 AND source_group_id=$4 AND source_memory_id=$5',
            [command.intentId, access.workspaceId, access.actorUserId, access.groupId, memoryId],
          )
        ).rows[0];
        if (!intent || intent.expires_at.getTime() <= this.now().getTime())
          throw new MemoryAccessError();
        if (
          intent.content_hash !== textHash(visible.text) ||
          intent.lineage_digest !== lineageDigest(visible)
        )
          throw new MemoryConflictError('source_version_conflict');
        const destination = await lockAuthorizedBot(
          connection,
          {
            actorUserId: access.actorUserId,
            workspaceId: access.workspaceId,
            botId: intent.destination_bot_id,
          },
          'edit',
        );
        const consumed = (
          await connection.query<{ private_memory_id: string }>(
            'SELECT private_memory_id FROM memory_promotion_confirmations WHERE intent_id=$1',
            [intent.id],
          )
        ).rows[0];
        if (consumed) {
          const existing = await this.privateRow(
            connection,
            destination.id,
            consumed.private_memory_id,
          );
          if (!existing) throw new MemoryAccessError();
          return { memory: projectPrivateMemory(existing), replayed: true };
        }
        const row = await this.row(connection, access, memoryId);
        if (!row) throw new MemoryAccessError();
        const approvedAt = this.now(),
          privateId = randomUUID(),
          versionId = randomUUID();
        await connection.query(
          'INSERT INTO bot_private_memories(id,workspace_id,bot_id,source_group_id,source_memory_id,source_memory_version_id,source_event_id,approver_user_id,approved_at,version,version_id,idempotency_key,command_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12)',
          [
            privateId,
            access.workspaceId,
            destination.id,
            access.groupId,
            memoryId,
            row.version_id,
            row.source_event_id,
            access.actorUserId,
            approvedAt,
            versionId,
            command.idempotencyKey,
            hash,
          ],
        );
        await connection.query(
          'INSERT INTO memory_promotion_confirmations(intent_id,private_memory_id,confirmed_at) VALUES($1,$2,$3)',
          [intent.id, privateId, approvedAt],
        );
        await connection.query(
          'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            randomUUID(),
            'memory.promoted',
            access.actorUserId,
            approvedAt,
            JSON.stringify({
              workspaceId: access.workspaceId,
              sourceGroupId: access.groupId,
              sourceMemoryId: memoryId,
              botId: destination.id,
              privateMemoryId: privateId,
              versionId,
              intentId: intent.id,
            }),
          ],
        );
        const created = await this.privateRow(connection, destination.id, privateId);
        if (!created) throw new Error('Private memory publication failed');
        return { memory: projectPrivateMemory(created), replayed: false };
      },
    );
  }
  async listPrivate(supplied: PrivateMemoryAccess, input: unknown, search = false) {
    const access = privateMemoryAccess(supplied),
      read = memoryRead(input, search);
    const result = await this.transaction(async (connection) => {
      try {
        await lockAuthorizedBot(
          connection,
          {
            actorUserId: access.actorUserId,
            workspaceId: access.workspaceId,
            botId: access.botId,
          },
          'edit',
        );
        const rows = await selectCurrentPrivateMemoryRows(
          connection,
          { workspaceId: access.workspaceId, botId: access.botId },
          { ...read, limit: read.limit + 1 },
        );
        const facts = (
          await selectApprovedFactRows(connection, {
            workspaceId: access.workspaceId,
            botId: access.botId,
            ...(read.query ? { query: read.query } : {}),
            ...(read.after ? { after: read.after } : {}),
            limit: read.limit + 1,
          })
        ).map(projectApprovedFact);
        const merged = [...rows.map(projectPrivateMemory), ...facts].sort((left, right) =>
          left.id < right.id ? -1 : 1,
        );
        const page = merged.slice(0, read.limit);
        return {
          allowed: true as const,
          value: {
            memories: page,
            nextAfter: merged.length > read.limit ? page.at(-1)!.id : null,
          },
        };
      } catch (error) {
        if (!accessDenied(error)) throw error;
        await this.auditDenial(
          connection,
          { ...access, groupId: access.botId },
          search ? 'search-private' : 'list-private',
          { botId: access.botId },
        );
        return { allowed: false as const };
      }
    });
    if (!result.allowed) throw new MemoryAccessError();
    return result.value;
  }
  async getPrivate(supplied: PrivateMemoryAccess, id: string): Promise<PrivateMemoryProjection> {
    const access = privateMemoryAccess(supplied),
      memoryId = memoryUuid(id);
    const result = await this.transaction(async (connection) => {
      try {
        await lockAuthorizedBot(
          connection,
          {
            actorUserId: access.actorUserId,
            workspaceId: access.workspaceId,
            botId: access.botId,
          },
          'edit',
        );
        const row = await this.privateRow(connection, access.botId, memoryId);
        if (!row) throw new MemoryAccessError();
        return { allowed: true as const, value: projectPrivateMemory(row) };
      } catch (error) {
        if (!accessDenied(error)) throw error;
        await this.auditDenial(connection, { ...access, groupId: access.botId }, 'read-private', {
          memoryId,
          botId: access.botId,
        });
        return { allowed: false as const };
      }
    });
    if (!result.allowed) throw new MemoryAccessError();
    return result.value;
  }
  async listCandidates(supplied: CandidateAccess, input: unknown) {
    const access = candidateAccess(supplied),
      read = memoryRead(input, false);
    return this.withCandidateAdmission(access, 'list-candidates', {}, async (connection) => {
      await ConversationTransaction.lock(
        connection,
        {
          actorUserId: access.actorUserId,
          workspaceId: access.workspaceId,
          conversationId: access.conversationId,
        },
        this.now,
        'inspect',
      );
      const parameters: unknown[] = [access.workspaceId, access.conversationId, read.limit + 1];
      const after = read.after ? ` AND c.id>$${parameters.push(read.after)}` : '';
      const rows = (
        await connection.query<import('./review.js').CandidateRow>(
          `SELECT c.id,c.run_id,c.workspace_id,c.status,c.current_revision,c.proposed_scope_kind,c.proposed_scope_id,c.confidence,c.output_event_id,c.origin_task_id,c.origin_bot_version_id,c.created_at,
                  t.bot_id AS origin_bot_id,t.conversation_id,conv.group_id,r.body,src.source_count
           FROM memory_candidates c
           JOIN tasks t ON t.id=c.origin_task_id
           JOIN conversations conv ON conv.id=t.conversation_id
           JOIN memory_candidate_revisions r ON r.candidate_id=c.id AND r.revision=c.current_revision
           JOIN (SELECT candidate_id,COUNT(*) AS source_count FROM memory_candidate_sources GROUP BY candidate_id) src ON src.candidate_id=c.id
           WHERE c.workspace_id=$1 AND t.conversation_id=$2${after}
           ORDER BY c.id LIMIT $3`,
          parameters,
        )
      ).rows;
      const selected = rows.slice(0, read.limit);
      return {
        candidates: selected.map(projectCandidate),
        nextAfter: rows.length > read.limit ? selected.at(-1)!.id : null,
      };
    });
  }
  async editCandidate(supplied: CandidateAccess, id: string, input: unknown) {
    const access = candidateAccess(supplied),
      candidateId = memoryUuid(id),
      command = candidateEditInput(input);
    return this.withCandidateAdmission(
      access,
      'edit-candidate',
      { candidateId },
      async (connection) => {
        const row = await loadCandidate(connection, access, candidateId);
        await lockReviewScopes(
          connection,
          access,
          { groupId: row.group_id, botId: row.origin_bot_id },
          undefined,
          this.now,
        );
        await lockCandidateRow(connection, row);
        if (row.status !== 'pending' || Number(row.current_revision) !== command.expectedRevision)
          throw new MemoryConflictError('source_version_conflict');
        const updated = await connection.query(
          "UPDATE memory_candidates SET current_revision=current_revision+1 WHERE id=$1 AND status='pending' AND current_revision=$2 RETURNING current_revision",
          [row.id, command.expectedRevision],
        );
        if (!updated.rows.length) throw new MemoryConflictError('source_version_conflict');
        await connection.query(
          'INSERT INTO memory_candidate_revisions(candidate_id,revision,body,author_user_id,created_at) VALUES($1,$2,$3,$4,$5)',
          [row.id, command.expectedRevision + 1, command.body, access.actorUserId, this.now()],
        );
        return projectCandidate(await loadCandidate(connection, access, candidateId));
      },
    );
  }
  async rejectCandidate(supplied: CandidateAccess, id: string, input: unknown) {
    const access = candidateAccess(supplied),
      candidateId = memoryUuid(id),
      command = candidateRejectInput(input);
    return this.withCandidateAdmission(
      access,
      'reject-candidate',
      { candidateId },
      async (connection) => {
        const replayHash = reviewCommandHash({
          type: 'memory.candidate.reject',
          candidateId,
          revision: command.expectedRevision,
          bodyHash: '',
        });
        const row = await loadCandidate(connection, access, candidateId);
        await lockReviewScopes(
          connection,
          access,
          { groupId: row.group_id, botId: row.origin_bot_id },
          undefined,
          this.now,
        );
        await lockCandidateRow(connection, row);
        const replay = await replayDecision(
          connection,
          access,
          command.idempotencyKey,
          reviewCommandHash({
            type: 'memory.candidate.reject',
            candidateId: row.id,
            revision: Number(row.current_revision),
            bodyHash: reviewTextHash(row.body),
          }),
        );
        if (replay) return { candidate: replay.candidate, replayed: true };
        if (row.status !== 'pending' || Number(row.current_revision) !== command.expectedRevision)
          throw new MemoryConflictError('source_version_conflict');
        void replayHash;
        await connection.query(
          "UPDATE memory_candidates SET status='rejected' WHERE id=$1 AND status='pending' AND current_revision=$2",
          [row.id, command.expectedRevision],
        );
        await insertDecision(connection, {
          access,
          row,
          decision: 'rejected',
          idempotencyKey: command.idempotencyKey,
          now: this.now(),
        });
        return {
          candidate: projectCandidate(await loadCandidate(connection, access, candidateId)),
          replayed: false,
        };
      },
    );
  }
  async approveCandidate(supplied: CandidateAccess, id: string, input: unknown) {
    const access = candidateAccess(supplied),
      candidateId = memoryUuid(id),
      command = candidateApproveInput(input);
    return this.withCandidateAdmission(
      access,
      'approve-candidate',
      { candidateId },
      async (connection) => {
        const row = await loadCandidate(connection, access, candidateId);
        await lockReviewScopes(
          connection,
          access,
          { groupId: row.group_id, botId: row.origin_bot_id },
          command.destination,
          this.now,
        );
        await lockCandidateRow(connection, row);
        const hash = reviewCommandHash({
          type: 'memory.candidate.approve',
          candidateId: row.id,
          revision: Number(row.current_revision),
          bodyHash: reviewTextHash(row.body),
          destination: command.destination,
          confidence: command.confidence,
        });
        const replay = await replayDecision(connection, access, command.idempotencyKey, hash);
        if (replay) return { candidate: replay.candidate, fact: replay.fact, replayed: true };
        if (row.status !== 'pending' || Number(row.current_revision) !== command.expectedRevision)
          throw new MemoryConflictError('source_version_conflict');
        if (requiresSeparateConfirmation(row.group_id, command.destination))
          throw new MemoryAccessError();
        const fact = await publishApprovedFact(connection, {
          access,
          row,
          destination: command.destination,
          confidence: command.confidence,
          now: this.now(),
        });
        await insertDecision(connection, {
          access,
          row,
          decision: 'approved',
          destination: command.destination,
          factId: fact.id,
          confidence: command.confidence,
          idempotencyKey: command.idempotencyKey,
          now: this.now(),
        });
        return {
          candidate: projectCandidate(await loadCandidate(connection, access, candidateId)),
          fact,
          replayed: false,
        };
      },
    );
  }
  async previewCandidate(supplied: CandidateAccess, id: string, input: unknown) {
    const access = candidateAccess(supplied),
      candidateId = memoryUuid(id),
      command = candidatePreviewInput(input);
    return this.withCandidateAdmission(
      access,
      'preview-candidate',
      { candidateId },
      async (connection) => {
        const row = await loadCandidate(connection, access, candidateId);
        if (!requiresSeparateConfirmation(row.group_id, command.destination))
          throw new MemoryInputError();
        const destinationBot = await lockReviewScopes(
          connection,
          access,
          { groupId: row.group_id, botId: row.origin_bot_id },
          command.destination,
          this.now,
        );
        await lockCandidateRow(connection, row);
        if (row.status !== 'pending' || Number(row.current_revision) !== command.expectedRevision)
          throw new MemoryConflictError('source_version_conflict');
        const createdAt = this.now(),
          expiresAt = new Date(createdAt.getTime() + REVIEW_PREVIEW_TTL_MS),
          intentId = randomUUID();
        await connection.query(
          `INSERT INTO memory_candidate_review_intents(
            id,workspace_id,actor_user_id,candidate_id,expected_revision,reviewed_body_hash,lineage_digest,destination_scope_kind,destination_scope_id,destination_version_id,confidence,disclosure_version,expires_at,created_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            intentId,
            access.workspaceId,
            access.actorUserId,
            row.id,
            Number(row.current_revision),
            reviewTextHash(row.body),
            candidateLineageDigest(row),
            command.destination.kind,
            command.destination.id,
            destinationBot?.version_id ?? null,
            command.confidence,
            REVIEW_DISCLOSURE_VERSION,
            expiresAt,
            createdAt,
          ],
        );
        return {
          preview: {
            id: intentId,
            expiresAt,
            content: row.body,
            destination: command.destination,
            visibility: destinationAudience(command.destination),
            disclosureVersion: REVIEW_DISCLOSURE_VERSION,
          },
        };
      },
    );
  }
  async confirmCandidate(supplied: CandidateAccess, id: string, input: unknown) {
    const access = candidateAccess(supplied),
      candidateId = memoryUuid(id),
      command = promotionConfirmInput(input);
    return this.withCandidateAdmission(
      access,
      'confirm-candidate',
      { candidateId },
      async (connection) => {
        const row = await loadCandidate(connection, access, candidateId);
        const intent = (
          await connection.query<{
            id: string;
            destination_scope_kind: CandidateAccess extends never ? never : string;
            destination_scope_id: string;
            destination_version_id: string | null;
            reviewed_body_hash: string;
            lineage_digest: string;
            expected_revision: number;
            confidence: number;
            expires_at: Date;
          }>(
            `SELECT id,destination_scope_kind,destination_scope_id,destination_version_id,reviewed_body_hash,lineage_digest,expected_revision,confidence,expires_at
             FROM memory_candidate_review_intents
             WHERE id=$1 AND workspace_id=$2 AND actor_user_id=$3 AND candidate_id=$4`,
            [command.intentId, access.workspaceId, access.actorUserId, candidateId],
          )
        ).rows[0];
        if (!intent || intent.expires_at.getTime() <= this.now().getTime())
          throw new MemoryAccessError();
        const destination = {
          kind: intent.destination_scope_kind as 'group' | 'bot' | 'workspace',
          id: intent.destination_scope_id,
        };
        const destinationBot = await lockReviewScopes(
          connection,
          access,
          { groupId: row.group_id, botId: row.origin_bot_id },
          destination,
          this.now,
        );
        await lockCandidateRow(connection, row);
        if (
          reviewTextHash(row.body) !== intent.reviewed_body_hash ||
          candidateLineageDigest(row) !== intent.lineage_digest ||
          Number(row.current_revision) !== Number(intent.expected_revision)
        )
          throw new MemoryConflictError('source_version_conflict');
        if (
          destination.kind === 'bot' &&
          destinationBot &&
          intent.destination_version_id &&
          destinationBot.version_id !== intent.destination_version_id
        )
          throw new MemoryConflictError('source_version_conflict');
        const hash = reviewCommandHash({
          type: 'memory.candidate.approve',
          candidateId: row.id,
          revision: Number(row.current_revision),
          bodyHash: reviewTextHash(row.body),
          destination,
          confidence: intent.confidence,
        });
        const replay = await replayDecision(connection, access, command.idempotencyKey, hash);
        if (replay) return { candidate: replay.candidate, fact: replay.fact, replayed: true };
        const consumed = (
          await connection.query<{ candidate_id: string }>(
            'SELECT candidate_id FROM memory_candidate_review_confirmations WHERE intent_id=$1',
            [intent.id],
          )
        ).rows[0];
        if (consumed) {
          const existing = await loadCandidate(connection, access, consumed.candidate_id);
          return {
            candidate: projectCandidate(existing),
            fact: (
              await selectApprovedFactRows(connection, {
                workspaceId: access.workspaceId,
                ...(destination.kind === 'group' ? { groupId: destination.id } : {}),
                ...(destination.kind === 'bot' ? { botId: destination.id } : {}),
                includeWorkspace: destination.kind === 'workspace',
                limit: 1,
              })
            )
              .map(projectApprovedFact)
              .find((fact) => fact.candidateId === row.id),
            replayed: true,
          };
        }
        if (row.status !== 'pending') throw new MemoryConflictError('source_version_conflict');
        const fact = await publishApprovedFact(connection, {
          access,
          row,
          destination,
          confidence: intent.confidence,
          now: this.now(),
        });
        await insertDecision(connection, {
          access,
          row,
          decision: 'approved',
          destination,
          factId: fact.id,
          confidence: intent.confidence,
          idempotencyKey: command.idempotencyKey,
          now: this.now(),
        });
        await connection.query(
          'INSERT INTO memory_candidate_review_confirmations(intent_id,candidate_id,confirmed_at) VALUES($1,$2,$3)',
          [intent.id, row.id, this.now()],
        );
        return {
          candidate: projectCandidate(await loadCandidate(connection, access, candidateId)),
          fact,
          replayed: false,
        };
      },
    );
  }
  private async withCandidateAdmission<T>(
    access: CandidateAccess,
    operation: Operation,
    refs: { candidateId?: string },
    action: (connection: SqlConnection) => Promise<T>,
  ): Promise<T> {
    const result = await this.transaction(async (connection) => {
      try {
        await lockWorkspaceMember(connection, access);
        return { allowed: true as const, value: await action(connection) };
      } catch (error) {
        if (!accessDenied(error)) throw error;
        await this.auditDenial(
          connection,
          {
            actorUserId: access.actorUserId,
            workspaceId: access.workspaceId,
            groupId: access.conversationId,
          },
          operation,
          { conversationId: access.conversationId, ...refs },
        );
        return { allowed: false as const };
      }
    });
    if (!result.allowed) throw new MemoryAccessError();
    return result.value;
  }
  private async privateRow(connection: SqlConnection, botId: string, memoryId: string) {
    return (
      await connection.query<PrivateMemoryRow>(
        `SELECT ${privateMemoryRowColumns} FROM ${privateMemoryCurrentFrom} WHERE ${privateMemoryCurrentWhere} AND p.bot_id=$1 AND p.id=$2`,
        [botId, memoryId],
      )
    ).rows[0];
  }
}

function lineageDigest(memory: MemoryProjection): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        memoryId: memory.id,
        versionId: memory.versionId,
        sourceEventId: memory.source.eventId,
      }),
    )
    .digest('hex');
}
function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function promotionCommandHash(
  sourceMemoryId: string,
  command: { intentId: string; idempotencyKey: string },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: 'memory.promote',
        sourceMemoryId,
        intentId: command.intentId,
      }),
    )
    .digest('hex');
}

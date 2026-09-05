import {
  memoryRowColumns,
  memoryRowTables,
  projectCurrentMemory,
  selectCurrentMemoryRows,
} from './current.js';
import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { GroupAccessError } from '../groups/service.js';
import { GroupBotTransaction } from '../group-bots/postgres-admission.js';
import { GroupBotAccessError } from '../group-bots/service.js';
import { BotAccessError } from '../bots/service.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { ConversationAccessError } from '../conversations/service.js';
import type { CurrentMessageSource } from '../conversations/message-source.js';
import {
  MemoryAccessError,
  MemoryConflictError,
  memoryAccess,
  memoryCommand,
  memoryCommandHash,
  memoryRead,
  memoryUuid,
  type MemoryAccess,
  type MemoryProjection,
  type MemoryRow,
} from './types.js';

type Admission = {
  conversationId?: string;
  lowerBound: number;
  source(messageId: string): Promise<CurrentMessageSource>;
};
type Operation = 'create' | 'read' | 'list' | 'search';
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
    refs: { messageId?: string; memoryId?: string } = {},
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
    refs: { messageId?: string; memoryId?: string },
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
      const selected = rows.slice(0, read.limit),
        memories: MemoryProjection[] = [];
      for (const row of selected) memories.push(await this.visible(row, admitted));
      return { memories, nextAfter: rows.length > read.limit ? selected.at(-1)!.id : null };
    });
  }
}

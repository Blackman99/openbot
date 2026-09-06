import { createHash } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { readRunExecution } from '../tasks/execution-state.js';
import { ConversationTransaction } from './postgres-repository.js';
import {
  conversationUuid,
  ConversationAccessError,
  InvalidConversationInputError,
} from './service.js';
import { encodeMessageCursor } from './cursor.js';
import { readStreamMessagePage, readStreamMessageReference } from './stream-message.js';
import {
  ConversationStreamError,
  encodeConversationStreamCursor,
  encodeConversationStreamEvent,
  parseConversationStreamCursor,
  validateConversationStreamPosition,
  STREAM_LIMITS,
  type ConversationStreamScope,
  type ConversationStreamBootstrap,
  type ConversationStreamPayload,
  type ExecutionState,
  type StreamPreview,
} from './stream-protocol.js';
import type { ConversationStreams } from './stream-delivery.js';

export class ConversationStreamService implements ConversationStreams {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async session(connection: SqlConnection, token: string, lock = false) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token))
      throw new ConversationStreamError('authentication_required');
    const row = (
      await connection.query<{ user_id: string; expires_at: Date; revoked_at: Date | null }>(
        `SELECT user_id,expires_at,revoked_at FROM sessions WHERE token_digest=$1${lock ? ' FOR SHARE' : ''}`,
        [createHash('sha256').update(token).digest('hex')],
      )
    ).rows[0];
    // Clock is sampled after a session/resource lock wait, not when opening the
    // stream. The SHARE lock serializes sign-out until this bounded delivery.
    if (!row || row.revoked_at || row.expires_at.getTime() <= this.now().getTime())
      throw new ConversationStreamError('authentication_required');
    return row.user_id;
  }
  private async inspect<T>(
    token: string,
    supplied: ConversationStreamScope,
    select: (connection: SqlConnection, scope: ConversationStreamScope) => Promise<T>,
    enqueue?: (result: T) => void,
  ) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const actorUserId = await this.session(connection, token);
      const scope = {
        workspaceId: conversationUuid(supplied.workspaceId),
        conversationId: conversationUuid(supplied.conversationId),
      };
      await ConversationTransaction.lock(
        connection,
        { ...scope, actorUserId },
        this.now,
        'inspect',
      );
      if ((await this.session(connection, token, true)) !== actorUserId)
        throw new ConversationStreamError('authentication_required');
      const result = await select(connection, scope);
      if ((await this.session(connection, token, true)) !== actorUserId)
        throw new ConversationStreamError('authentication_required');
      enqueue?.(result);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      if (error instanceof ConversationAccessError)
        throw new ConversationStreamError('conversation_forbidden');
      if (error instanceof InvalidConversationInputError)
        throw new ConversationStreamError('invalid_stream_cursor');
      throw error;
    } finally {
      connection.release();
    }
  }
  private async position(
    connection: SqlConnection,
    scope: ConversationStreamScope,
    encoded: unknown,
  ) {
    const cursor = parseConversationStreamCursor(encoded, scope);
    if (!cursor) throw new ConversationStreamError('invalid_stream_cursor');
    const state = (
      await connection.query<{ last_sequence: string | number; floor: string | number | null }>(
        'SELECT c.last_sequence,s.floor FROM conversations c LEFT JOIN conversation_delivery_state s ON s.conversation_id=c.id WHERE c.id=$1',
        [scope.conversationId],
      )
    ).rows[0]!;
    validateConversationStreamPosition(
      cursor.after,
      Number(state.floor ?? 0),
      Number(state.last_sequence),
    );
    return cursor.after;
  }
  check(token: string, scope: ConversationStreamScope, cursor: unknown) {
    return this.inspect(token, scope, async (connection, current) =>
      encodeConversationStreamCursor(current, await this.position(connection, current, cursor)),
    );
  }
  async deliver(
    token: string,
    scope: ConversationStreamScope,
    cursor: string,
    enqueue: (frame: string) => void,
  ) {
    const result = await this.inspect(
      token,
      scope,
      async (connection, current) => {
        const after = await this.position(connection, current, cursor);
        const row = (
          await connection.query<{
            sequence: string | number;
            occurred_at: Date;
            event_type: ConversationStreamPayload['type'];
            ledger_event_id: string | null;
            run_id: string | null;
            execution: ExecutionState | null;
            delta_text: string | null;
            start_byte: number | null;
            end_byte: number | null;
          }>(
            'SELECT * FROM conversation_delivery_events WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 1',
            [current.conversationId, after],
          )
        ).rows[0];
        if (!row)
          return {
            cursor: encodeConversationStreamCursor(current, after),
            delivered: false,
            frame: undefined,
          };
        let payload: ConversationStreamPayload;
        if (row.event_type === 'message.changed') {
          const source = (
            await connection.query<{ message_id: string }>(
              'SELECT message_id FROM conversation_events WHERE conversation_id=$1 AND id=$2',
              [current.conversationId, row.ledger_event_id],
            )
          ).rows[0];
          if (!source) throw new ConversationStreamError('conversation_stream_unavailable');
          payload = {
            type: row.event_type,
            data: {
              message: await readStreamMessageReference(
                connection,
                current.conversationId,
                source.message_id,
              ),
            },
          };
        } else if (row.event_type === 'task.run.updated')
          payload = { type: row.event_type, data: { execution: row.execution! } };
        else if (row.event_type === 'assistant.delta') {
          const run = (
            await connection.query<{ task_id: string; attempt: number }>(
              'SELECT task_id,attempt FROM task_runs WHERE id=$1',
              [row.run_id],
            )
          ).rows[0]!;
          payload = {
            type: row.event_type,
            data: {
              taskId: run.task_id,
              runId: row.run_id!,
              attempt: run.attempt,
              startByte: row.start_byte!,
              endByte: row.end_byte!,
              text: row.delta_text!,
            },
          };
        } else {
          const ledger = (
            await connection.query<{
              event_type: string;
              body: string | null;
              event_data: {
                taskId: string;
                dimension:
                  | 'duration'
                  | 'turns'
                  | 'delegationDepth'
                  | 'handoffs'
                  | 'inputTokens'
                  | 'outputTokens'
                  | 'totalTokens';
                used: number;
                limit: number;
                source: 'workspace' | 'group' | 'task' | 'run';
                soft: boolean;
                hard: boolean;
              } | null;
            }>(
              'SELECT event_type,body,event_data FROM conversation_events WHERE conversation_id=$1 AND id=$2',
              [current.conversationId, row.ledger_event_id],
            )
          ).rows[0];
          payload =
            ledger?.event_type === 'task.limit.warning' && ledger.body && ledger.event_data
              ? { type: 'task.limit.warning', data: { ...ledger.event_data, body: ledger.body } }
              : { type: 'conversation.invalidated', data: { reason: 'membership' } };
        }
        return {
          cursor: encodeConversationStreamCursor(current, Number(row.sequence)),
          delivered: true,
          frame: encodeConversationStreamEvent(
            current,
            Number(row.sequence),
            row.occurred_at,
            payload,
          ),
        };
      },
      (value) => {
        if (value.frame) enqueue(value.frame);
      },
    );
    return { cursor: result.cursor, delivered: result.delivered };
  }
  bootstrap(token: string, scope: ConversationStreamScope): Promise<ConversationStreamBootstrap> {
    return this.inspect(token, scope, async (connection, current) => {
      const row = (
        await connection.query<{ last_sequence: string | number }>(
          'SELECT last_sequence FROM conversations WHERE id=$1',
          [current.conversationId],
        )
      ).rows[0]!;
      const horizon = Number(row.last_sequence),
        messages = await readStreamMessagePage(connection, current.conversationId, horizon);
      const tasks = (
        await connection.query<{ id: string; sequence: string | number }>(
          'SELECT t.id,e.sequence FROM tasks t JOIN conversation_events e ON e.id=t.trigger_event_id WHERE t.conversation_id=$1 AND e.sequence<=$2 ORDER BY e.sequence LIMIT 21',
          [current.conversationId, horizon],
        )
      ).rows;
      const executions: ExecutionState[] = [];
      for (const task of tasks.slice(0, STREAM_LIMITS.bootstrapExecutions)) {
        const run = (
          await connection.query<{ id: string }>(
            'SELECT id FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1',
            [task.id],
          )
        ).rows[0]!;
        const selected = await readRunExecution(connection, run.id);
        if (!selected) throw new ConversationStreamError('conversation_stream_unavailable');
        executions.push(selected.execution);
      }
      const result: ConversationStreamBootstrap = {
        schemaVersion: 1,
        cursor: encodeConversationStreamCursor(current, horizon),
        conversationId: current.conversationId,
        ...messages,
        executions,
        nextTaskCursor:
          tasks.length > STREAM_LIMITS.bootstrapExecutions
            ? encodeMessageCursor({
                v: 1,
                conversationId: current.conversationId,
                after: Number(tasks[STREAM_LIMITS.bootstrapExecutions - 1]!.sequence),
                horizon,
              })
            : null,
        previews: [],
        previewsTruncated: false,
      };
      await this.previews(connection, current.conversationId, result);
      if (Buffer.byteLength(JSON.stringify(result)) > STREAM_LIMITS.bootstrapBytes)
        throw new ConversationStreamError('conversation_stream_unavailable');
      return result;
    });
  }
  private async previews(
    connection: SqlConnection,
    conversationId: string,
    result: ConversationStreamBootstrap,
  ) {
    const active = (
      await connection.query<{
        id: string;
        task_id: string;
        attempt: number;
        delivered_bytes: number | null;
      }>(
        "SELECT r.id,r.task_id,r.attempt,s.delivered_bytes FROM task_runs r JOIN tasks t ON t.id=r.task_id LEFT JOIN task_run_streams s ON s.run_id=r.id WHERE t.conversation_id=$1 AND r.status='running' ORDER BY r.created_at,r.id LIMIT 9",
        [conversationId],
      )
    ).rows;
    result.previewsTruncated = active.length > STREAM_LIMITS.bootstrapPreviews;
    let bytes = 0;
    for (const run of active.slice(0, STREAM_LIMITS.bootstrapPreviews)) {
      if (!run.delivered_bytes) continue;
      if (bytes + run.delivered_bytes > STREAM_LIMITS.previewBytes) {
        result.previewsTruncated = true;
        continue;
      }
      const deltas = (
        await connection.query<{ delta_text: string; start_byte: number; end_byte: number }>(
          "SELECT delta_text,start_byte,end_byte FROM conversation_delivery_events WHERE run_id=$1 AND event_type='assistant.delta' ORDER BY sequence LIMIT 10000",
          [run.id],
        )
      ).rows;
      let text = '',
        endByte = 0;
      for (const delta of deltas) {
        if (
          delta.start_byte !== endByte ||
          Buffer.byteLength(delta.delta_text) !== delta.end_byte - delta.start_byte ||
          delta.end_byte > run.delivered_bytes
        )
          break;
        text += delta.delta_text;
        endByte = delta.end_byte;
      }
      if (endByte !== run.delivered_bytes) {
        result.previewsTruncated = true;
        continue;
      }
      const preview: StreamPreview = {
        taskId: run.task_id,
        runId: run.id,
        attempt: run.attempt,
        endByte,
        text,
      };
      result.previews.push(preview);
      if (Buffer.byteLength(JSON.stringify(result)) > STREAM_LIMITS.bootstrapBytes) {
        result.previews.pop();
        result.previewsTruncated = true;
        continue;
      }
      bytes += endByte;
    }
  }
}

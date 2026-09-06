import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import {
  WORKSPACE_EVENT_LIMITS,
  WORKSPACE_EVENT_TYPES,
  WorkspaceEventError,
  encodeWorkspaceEventFrame,
  parseWorkspaceEventCursor,
  validateWorkspaceEventPosition,
  type WorkspaceEventType,
} from './protocol.js';

export interface WorkspaceEventAppendInput {
  workspaceId: string;
  type: WorkspaceEventType;
  data: Record<string, unknown>;
  occurredAt?: Date;
}

async function ensureStream(connection: SqlConnection, workspaceId: string) {
  await connection.query(
    `INSERT INTO workspace_event_streams(workspace_id, last_sequence, floor, retained_count, retained_bytes)
     VALUES($1, 0, 0, 0, 0) ON CONFLICT(workspace_id) DO NOTHING`,
    [workspaceId],
  );
}

export class WorkspaceEventService {
  constructor(
    private readonly pool: SqlPool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async append(input: WorkspaceEventAppendInput): Promise<{ sequence: number; frame: string }> {
    if (!WORKSPACE_EVENT_TYPES.includes(input.type))
      throw new WorkspaceEventError('events_unavailable');
    const workspaceId = input.workspaceId.toLowerCase();
    const occurredAt = input.occurredAt ?? this.clock();
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await ensureStream(connection, workspaceId);
      const locked = (
        await connection.query<{ last_sequence: string | number; floor: string | number }>(
          'SELECT last_sequence, floor FROM workspace_event_streams WHERE workspace_id=$1 FOR UPDATE',
          [workspaceId],
        )
      ).rows[0];
      if (!locked) throw new WorkspaceEventError('events_unavailable');
      const sequence = Number(locked.last_sequence) + 1;
      const frame = encodeWorkspaceEventFrame(
        { workspaceId },
        sequence,
        occurredAt,
        input.type,
        input.data,
      );
      const byteSize = Math.max(64, Buffer.byteLength(frame));
      await connection.query(
        `INSERT INTO workspace_events(workspace_id, sequence, occurred_at, event_type, payload, byte_size)
         VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
        [workspaceId, sequence, occurredAt, input.type, JSON.stringify(input.data), byteSize],
      );
      await connection.query(
        `UPDATE workspace_event_streams
         SET last_sequence=$2, retained_count=retained_count+1, retained_bytes=retained_bytes+$3
         WHERE workspace_id=$1`,
        [workspaceId, sequence, byteSize],
      );
      await reclaimWorkspaceEvents(connection, workspaceId, this.clock());
      await connection.query('COMMIT');
      return { sequence, frame };
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async resolveReplay(
    workspaceId: string,
    lastEventId: string | string[] | undefined,
  ): Promise<{ frames: string[] }> {
    const raw = Array.isArray(lastEventId) ? lastEventId : lastEventId ? [lastEventId] : [];
    if (raw.length !== 1) throw new WorkspaceEventError('invalid_stream_cursor');
    const cursor = parseWorkspaceEventCursor(raw[0], { workspaceId });
    if (!cursor) throw new WorkspaceEventError('invalid_stream_cursor');
    const connection = await this.pool.connect();
    try {
      await ensureStream(connection, workspaceId);
      const state = (
        await connection.query<{ last_sequence: string | number; floor: string | number }>(
          'SELECT last_sequence, floor FROM workspace_event_streams WHERE workspace_id=$1',
          [workspaceId],
        )
      ).rows[0];
      if (!state) throw new WorkspaceEventError('events_unavailable');
      const floor = Number(state.floor);
      const tail = Number(state.last_sequence);
      validateWorkspaceEventPosition(cursor.after, floor, tail);
      const rows = (
        await connection.query<{
          sequence: string | number;
          occurred_at: Date;
          event_type: WorkspaceEventType;
          payload: Record<string, unknown> | string;
        }>(
          `SELECT sequence, occurred_at, event_type, payload
           FROM workspace_events
           WHERE workspace_id=$1 AND sequence>$2
           ORDER BY sequence`,
          [workspaceId, cursor.after],
        )
      ).rows;
      return {
        frames: rows.map((row) => {
          const data =
            typeof row.payload === 'string'
              ? (JSON.parse(row.payload) as Record<string, unknown>)
              : row.payload;
          return encodeWorkspaceEventFrame(
            { workspaceId },
            Number(row.sequence),
            row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
            row.event_type,
            data,
          );
        }),
      };
    } finally {
      connection.release();
    }
  }

  async reclaim(workspaceId: string, now = this.clock()): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await ensureStream(connection, workspaceId);
      await connection.query(
        'SELECT workspace_id FROM workspace_event_streams WHERE workspace_id=$1 FOR UPDATE',
        [workspaceId],
      );
      await reclaimWorkspaceEvents(connection, workspaceId, now);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

export async function reclaimWorkspaceEvents(
  connection: SqlConnection,
  workspaceId: string,
  now: Date,
) {
  const rows = (
    await connection.query<{ sequence: string | number; occurred_at: Date; byte_size: number }>(
      'SELECT sequence, occurred_at, byte_size FROM workspace_events WHERE workspace_id=$1 ORDER BY sequence LIMIT 10001',
      [workspaceId],
    )
  ).rows;
  let bytes = rows.reduce((sum, row) => sum + row.byte_size, 0);
  let remove = 0;
  const expiredAt = now.getTime() - WORKSPACE_EVENT_LIMITS.retentionMs;
  for (let i = 0; i < rows.length; i++) {
    const occurred =
      rows[i]!.occurred_at instanceof Date
        ? rows[i]!.occurred_at.getTime()
        : new Date(rows[i]!.occurred_at).getTime();
    if (occurred <= expiredAt) remove = i + 1;
  }
  for (let i = 0; i < remove; i++) bytes -= rows[i]!.byte_size;
  while (
    rows.length - remove > WORKSPACE_EVENT_LIMITS.retainedEvents ||
    bytes > WORKSPACE_EVENT_LIMITS.retainedBytes
  )
    bytes -= rows[remove++]!.byte_size;
  if (remove) {
    const floor = Number(rows[remove - 1]!.sequence);
    await connection.query(
      'UPDATE workspace_event_streams SET floor=$2, retained_count=$3, retained_bytes=$4 WHERE workspace_id=$1',
      [workspaceId, floor, rows.length - remove, bytes],
    );
    await connection.query('DELETE FROM workspace_events WHERE workspace_id=$1 AND sequence<=$2', [
      workspaceId,
      floor,
    ]);
  } else {
    await connection.query(
      'UPDATE workspace_event_streams SET retained_count=$2, retained_bytes=$3 WHERE workspace_id=$1',
      [workspaceId, rows.length, bytes],
    );
  }
}

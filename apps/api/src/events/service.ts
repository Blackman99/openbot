import { createHash } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { ApiTokenAuthenticationError, ApiTokenScopeError } from '../api-tokens/service.js';
import { lockWorkspaceAuthority } from '../database/workspace-lock.js';
import type { WorkspaceEventAdmission } from './delivery.js';
import {
  WORKSPACE_EVENT_LIMITS,
  WORKSPACE_EVENT_TYPES,
  WorkspaceEventError,
  encodeWorkspaceEventCursor,
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
  groupId?: string | null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function ensureStream(connection: SqlConnection, workspaceId: string) {
  await connection.query(
    `INSERT INTO workspace_event_streams(workspace_id, last_sequence, floor, retained_count, retained_bytes)
     VALUES($1, 0, 0, 0, 0) ON CONFLICT(workspace_id) DO NOTHING`,
    [workspaceId],
  );
}

function normalizePayload(
  data: Record<string, unknown>,
  groupId?: string | null,
): Record<string, unknown> {
  const payload = { ...data };
  if (groupId) {
    if (!uuidPattern.test(groupId)) throw new WorkspaceEventError('events_unavailable');
    payload.groupId = groupId.toLowerCase();
  }
  return payload;
}

export async function appendWorkspaceEvent(
  connection: SqlConnection,
  input: WorkspaceEventAppendInput,
  clock: () => Date = () => new Date(),
): Promise<{ sequence: number; frame: string }> {
  if (!WORKSPACE_EVENT_TYPES.includes(input.type))
    throw new WorkspaceEventError('events_unavailable');
  const workspaceId = input.workspaceId.toLowerCase();
  const occurredAt = input.occurredAt ?? clock();
  const payload = normalizePayload(input.data, input.groupId);
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
    payload,
  );
  const byteSize = Math.max(64, Buffer.byteLength(frame));
  await connection.query(
    `INSERT INTO workspace_events(workspace_id, sequence, occurred_at, event_type, payload, byte_size)
     VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
    [workspaceId, sequence, occurredAt, input.type, JSON.stringify(payload), byteSize],
  );
  await connection.query(
    `UPDATE workspace_event_streams
     SET last_sequence=$2, retained_count=retained_count+1, retained_bytes=retained_bytes+$3
     WHERE workspace_id=$1`,
    [workspaceId, sequence, byteSize],
  );
  await reclaimWorkspaceEvents(connection, workspaceId, clock());
  return { sequence, frame };
}

export class WorkspaceEventService {
  constructor(
    private readonly pool: SqlPool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async append(input: WorkspaceEventAppendInput): Promise<{ sequence: number; frame: string }> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      if (!(await lockWorkspaceAuthority(connection, input.workspaceId.toLowerCase())))
        throw new WorkspaceEventError('events_unavailable');
      const result = await appendWorkspaceEvent(connection, input, this.clock);
      await connection.query('COMMIT');
      return result;
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
    allowedGroupIds?: ReadonlySet<string> | 'all',
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
      validateWorkspaceEventPosition(
        cursor.after,
        Number(state.floor),
        Number(state.last_sequence),
      );
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
        frames: rows.flatMap((row) => {
          const data =
            typeof row.payload === 'string'
              ? (JSON.parse(row.payload) as Record<string, unknown>)
              : row.payload;
          if (!isGroupAuthorized(data.groupId, allowedGroupIds ?? 'all')) return [];
          return [
            encodeWorkspaceEventFrame(
              { workspaceId },
              Number(row.sequence),
              row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
              row.event_type,
              data,
            ),
          ];
        }),
      };
    } finally {
      connection.release();
    }
  }

  async openCursor(
    admission: WorkspaceEventAdmission,
    workspaceId: string,
    lastEventId: string | string[] | undefined,
  ): Promise<string> {
    return this.withAdmission(admission, workspaceId, async (connection) => {
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
      if (lastEventId === undefined) return encodeWorkspaceEventCursor({ workspaceId }, tail);
      const raw = Array.isArray(lastEventId) ? lastEventId : [lastEventId];
      if (raw.length !== 1) throw new WorkspaceEventError('invalid_stream_cursor');
      const cursor = parseWorkspaceEventCursor(raw[0], { workspaceId });
      if (!cursor) throw new WorkspaceEventError('invalid_stream_cursor');
      validateWorkspaceEventPosition(cursor.after, floor, tail);
      return encodeWorkspaceEventCursor({ workspaceId }, cursor.after);
    });
  }

  async deliver(
    admission: WorkspaceEventAdmission,
    workspaceId: string,
    cursor: string,
    enqueue: (frame: string) => void,
  ): Promise<{ cursor: string; delivered: boolean }> {
    return this.withAdmission(admission, workspaceId, async (connection, allowedGroups) => {
      await ensureStream(connection, workspaceId);
      const parsed = parseWorkspaceEventCursor(cursor, { workspaceId });
      if (!parsed) throw new WorkspaceEventError('invalid_stream_cursor');
      const state = (
        await connection.query<{ last_sequence: string | number; floor: string | number }>(
          'SELECT last_sequence, floor FROM workspace_event_streams WHERE workspace_id=$1',
          [workspaceId],
        )
      ).rows[0];
      if (!state) throw new WorkspaceEventError('events_unavailable');
      validateWorkspaceEventPosition(
        parsed.after,
        Number(state.floor),
        Number(state.last_sequence),
      );
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
           ORDER BY sequence
           LIMIT 32`,
          [workspaceId, parsed.after],
        )
      ).rows;
      let after = parsed.after;
      for (const row of rows) {
        after = Number(row.sequence);
        const data =
          typeof row.payload === 'string'
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : row.payload;
        if (!isGroupAuthorized(data.groupId, allowedGroups)) continue;
        const frame = encodeWorkspaceEventFrame(
          { workspaceId },
          after,
          row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
          row.event_type,
          data,
        );
        enqueue(frame);
        return {
          cursor: encodeWorkspaceEventCursor({ workspaceId }, after),
          delivered: true,
        };
      }
      return {
        cursor: encodeWorkspaceEventCursor({ workspaceId }, after),
        delivered: false,
      };
    });
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

  private async withAdmission<T>(
    admission: WorkspaceEventAdmission,
    workspaceId: string,
    select: (connection: SqlConnection, allowedGroups: ReadonlySet<string> | 'all') => Promise<T>,
  ): Promise<T> {
    if (admission.workspaceId !== workspaceId) throw new WorkspaceEventError('events_forbidden');
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      if (!(await lockWorkspaceAuthority(connection, workspaceId)))
        throw new WorkspaceEventError('events_forbidden');
      const actorUserId = await recheckAdmission(connection, admission, workspaceId, this.clock);
      const allowedGroups = await loadAuthorizedGroupIds(connection, workspaceId, actorUserId);
      const result = await select(connection, allowedGroups);
      await recheckAdmission(connection, admission, workspaceId, this.clock);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw mapAdmissionError(error);
    } finally {
      connection.release();
    }
  }
}

async function recheckAdmission(
  connection: SqlConnection,
  admission: WorkspaceEventAdmission,
  workspaceId: string,
  clock: () => Date,
): Promise<string> {
  if (admission.kind === 'token') {
    try {
      await admission.admit(connection);
    } catch (error) {
      throw mapAdmissionError(error);
    }
    return admission.userId;
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(admission.sessionToken))
    throw new WorkspaceEventError('invalid_api_token');
  const row = (
    await connection.query<{
      user_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT s.user_id,s.expires_at,s.revoked_at
       FROM sessions s
       INNER JOIN workspace_memberships m ON m.user_id=s.user_id AND m.workspace_id=$2
       WHERE s.token_digest=$1`,
      [createHash('sha256').update(admission.sessionToken).digest('hex'), workspaceId],
    )
  ).rows[0];
  if (
    !row ||
    row.revoked_at ||
    row.expires_at.getTime() <= clock().getTime() ||
    row.user_id !== admission.userId
  )
    throw new WorkspaceEventError('invalid_api_token');
  return row.user_id;
}

function isGroupAuthorized(groupId: unknown, allowed: ReadonlySet<string> | 'all'): boolean {
  if (allowed === 'all') return true;
  if (groupId === undefined || groupId === null) return true;
  if (typeof groupId !== 'string' || !uuidPattern.test(groupId)) return false;
  return allowed.has(groupId.toLowerCase());
}

async function loadAuthorizedGroupIds(
  connection: SqlConnection,
  workspaceId: string,
  userId: string,
): Promise<ReadonlySet<string>> {
  const rows = (
    await connection.query<{ id: string }>(
      `SELECT g.id FROM groups g
       INNER JOIN group_memberships m ON m.group_id=g.id AND m.user_id=$2
       WHERE g.workspace_id=$1 AND g.archived_at IS NULL`,
      [workspaceId, userId],
    )
  ).rows;
  return new Set(rows.map((row) => row.id.toLowerCase()));
}

function mapAdmissionError(error: unknown): Error {
  if (error instanceof WorkspaceEventError) return error;
  if (error instanceof ApiTokenAuthenticationError)
    return new WorkspaceEventError('invalid_api_token');
  if (error instanceof ApiTokenScopeError) return new WorkspaceEventError('insufficient_scope');
  return error instanceof Error ? error : new WorkspaceEventError('events_unavailable');
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

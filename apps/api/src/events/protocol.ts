export const WORKSPACE_EVENT_LIMITS = Object.freeze({
  cursorCharacters: 512,
  frameBytes: 256 * 1024,
  queuedBytes: 512 * 1024,
  drainMs: 10_000,
  pollMs: 1000,
  heartbeatMs: 15_000,
  retainedEvents: 10_000,
  retainedBytes: 16 * 1024 * 1024,
  retentionMs: 24 * 60 * 60 * 1000,
});

export const WORKSPACE_EVENT_TYPES = [
  'task.terminal',
  'task.cancelled',
  'task.approval',
  'task.budget_exhausted',
  'task.updated',
] as const;
export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number];

export interface WorkspaceEventScope {
  workspaceId: string;
}
export interface WorkspaceEventCursor extends WorkspaceEventScope {
  v: 1;
  after: number;
}
export interface WorkspaceEventRecord {
  schemaVersion: 1;
  cursor: string;
  workspaceId: string;
  sequence: number;
  occurredAt: string;
  type: WorkspaceEventType;
  data: Record<string, unknown>;
}

const statuses = {
  invalid_stream_cursor: 400,
  cursor_expired: 410,
  invalid_api_token: 401,
  insufficient_scope: 403,
  events_forbidden: 403,
  events_unavailable: 503,
  slow_consumer: 503,
} as const;
export type WorkspaceEventCode = keyof typeof statuses;
export type WorkspaceEventControl = Exclude<WorkspaceEventCode, 'invalid_stream_cursor'>;
export class WorkspaceEventError extends Error {
  readonly statusCode: number;
  constructor(readonly code: WorkspaceEventCode) {
    super(code);
    this.statusCode = statuses[code];
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function sequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function encodeWorkspaceEventCursor(scope: WorkspaceEventScope, after: number) {
  if (!uuidPattern.test(scope.workspaceId) || !sequence(after))
    throw new WorkspaceEventError('invalid_stream_cursor');
  return Buffer.from(JSON.stringify({ v: 1, workspaceId: scope.workspaceId, after })).toString(
    'base64url',
  );
}

export function parseWorkspaceEventCursor(
  value: unknown,
  scope?: WorkspaceEventScope,
): WorkspaceEventCursor | undefined {
  if (
    typeof value !== 'string' ||
    value.length > WORKSPACE_EVENT_LIMITS.cursorCharacters ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined;
    const item = decoded as Record<string, unknown>;
    if (
      Object.keys(item).length !== 3 ||
      item.v !== 1 ||
      typeof item.workspaceId !== 'string' ||
      !uuidPattern.test(item.workspaceId) ||
      typeof item.after !== 'number' ||
      !sequence(item.after) ||
      encodeWorkspaceEventCursor({ workspaceId: item.workspaceId }, item.after) !== value
    )
      return undefined;
    if (scope && item.workspaceId !== scope.workspaceId) return undefined;
    return { v: 1, workspaceId: item.workspaceId, after: item.after };
  } catch {
    return undefined;
  }
}

export function validateWorkspaceEventPosition(after: number, floor: number, tail: number) {
  if (!sequence(after) || !sequence(floor) || !sequence(tail) || floor > tail || after > tail)
    throw new WorkspaceEventError('invalid_stream_cursor');
  if (after < floor) throw new WorkspaceEventError('cursor_expired');
}

export function encodeWorkspaceEventFrame(
  scope: WorkspaceEventScope,
  position: number,
  occurredAt: Date,
  type: WorkspaceEventType,
  data: Record<string, unknown>,
): string {
  if (!WORKSPACE_EVENT_TYPES.includes(type)) throw new WorkspaceEventError('events_unavailable');
  const cursor = encodeWorkspaceEventCursor(scope, position);
  const envelope: WorkspaceEventRecord = {
    schemaVersion: 1,
    cursor,
    workspaceId: scope.workspaceId,
    sequence: position,
    occurredAt: occurredAt.toISOString(),
    type,
    data,
  };
  const frame = `id: ${cursor}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`;
  if (Buffer.byteLength(frame) > WORKSPACE_EVENT_LIMITS.frameBytes)
    throw new WorkspaceEventError('events_unavailable');
  return frame;
}

export function encodeWorkspaceEventControl(code: WorkspaceEventControl): string {
  return `event: stream.control\ndata: ${JSON.stringify({ schemaVersion: 1, code })}\n\n`;
}

export const WORKSPACE_EVENT_HEARTBEAT = ': heartbeat\n\n';

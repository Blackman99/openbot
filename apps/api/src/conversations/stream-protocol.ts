import type { ProviderProtocol } from '../providers/model-events.js';
import type { RoutingSummary } from '../routing/matcher.js';
import type { TaskFailure, Usage } from '../tasks/queue.js';
import type { TaskStatus } from '../tasks/service.js';

export const STREAM_LIMITS = Object.freeze({
  cursorCharacters: 512,
  frameBytes: 256 * 1024,
  deltaBytes: 4096,
  pendingDeltaBytes: 8192,
  coalesceMs: 25,
  bootstrapBytes: 1024 * 1024,
  bootstrapMessages: 20,
  bootstrapExecutions: 20,
  bootstrapPreviews: 8,
  previewBytes: 256 * 1024,
  queuedBytes: 512 * 1024,
  drainMs: 10_000,
  pollMs: 1000,
  heartbeatMs: 15_000,
  retainedEvents: 10_000,
  retainedBytes: 16 * 1024 * 1024,
  retentionMs: 24 * 60 * 60 * 1000,
});
export interface ConversationStreamScope {
  workspaceId: string;
  conversationId: string;
}
export interface ConversationStreamCursor extends ConversationStreamScope {
  v: 1;
  after: number;
}
export interface MessageReference {
  messageId: string;
  creationSequence: number;
  versionEventId: string;
  sequence: number;
  deleted: boolean;
  taskId: string | null;
  runId: string | null;
}
export interface ExecutionState {
  taskId: string;
  runId: string;
  attempt: number;
  taskStatus: TaskStatus;
  runStatus: TaskStatus;
  bot: { id: string; displayName: string; versionId: string; versionNumber: number };
  executionUser: { id: string; displayName: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  provider: { protocol: ProviderProtocol; modelId: string } | null;
  usage: Usage | null;
  error: TaskFailure | null;
  output: { messageId: string; eventId: string; sequence: number } | null;
  routing?: RoutingSummary;
  continuation?: {
    origin: 'provider_retry' | 'model_fallback';
    reason: 'provider_rate_limited' | 'provider_unavailable' | 'provider_connection_reset';
    previousRunId: string;
    previousProvider: { protocol: ProviderProtocol; modelId: string };
    nextProvider: { protocol: ProviderProtocol; modelId: string };
    dueAt: string;
    admitted: boolean;
  };
}
export interface AssistantDelta {
  taskId: string;
  runId: string;
  attempt: number;
  startByte: number;
  endByte: number;
  text: string;
}
export interface ExecutionLimitWarning {
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
  body: string;
}
export type ConversationStreamPayload =
  | { type: 'message.changed'; data: { message: MessageReference } }
  | { type: 'task.run.updated'; data: { execution: ExecutionState } }
  | { type: 'assistant.delta'; data: AssistantDelta }
  | { type: 'task.limit.warning'; data: ExecutionLimitWarning }
  | { type: 'conversation.invalidated'; data: { reason: 'membership' } };
export type ConversationStreamEvent = ConversationStreamPayload & {
  schemaVersion: 1;
  cursor: string;
  conversationId: string;
  sequence: number;
  occurredAt: string;
};
export interface StreamPreview {
  taskId: string;
  runId: string;
  attempt: number;
  endByte: number;
  text: string;
}
export interface ConversationStreamBootstrap {
  schemaVersion: 1;
  cursor: string;
  conversationId: string;
  messages: MessageReference[];
  nextMessageCursor: string | null;
  executions: ExecutionState[];
  nextTaskCursor: string | null;
  previews: StreamPreview[];
  previewsTruncated: boolean;
}
const statuses = {
  authentication_required: 401,
  conversation_forbidden: 403,
  invalid_stream_cursor: 400,
  cursor_expired: 410,
  conversation_stream_unavailable: 503,
  slow_consumer: 503,
} as const;
export type ConversationStreamCode = keyof typeof statuses;
export type ConversationStreamControl = Exclude<ConversationStreamCode, 'invalid_stream_cursor'>;
export class ConversationStreamError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ConversationStreamCode) {
    super(code);
    this.statusCode = statuses[code];
  }
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function sequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
export function encodeConversationStreamCursor(scope: ConversationStreamScope, after: number) {
  if (
    !uuidPattern.test(scope.workspaceId) ||
    !uuidPattern.test(scope.conversationId) ||
    !sequence(after)
  )
    throw new ConversationStreamError('invalid_stream_cursor');
  return Buffer.from(
    JSON.stringify({
      v: 1,
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      after,
    }),
  ).toString('base64url');
}
export function parseConversationStreamCursor(
  value: unknown,
  scope: ConversationStreamScope,
): ConversationStreamCursor | undefined {
  if (
    typeof value !== 'string' ||
    value.length > STREAM_LIMITS.cursorCharacters ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined;
    const item = decoded as Record<string, unknown>;
    if (
      Object.keys(item).length !== 4 ||
      item.v !== 1 ||
      item.workspaceId !== scope.workspaceId ||
      item.conversationId !== scope.conversationId ||
      typeof item.after !== 'number' ||
      encodeConversationStreamCursor(scope, item.after) !== value
    )
      return undefined;
    return { v: 1, ...scope, after: item.after };
  } catch {
    return undefined;
  }
}
export function validateConversationStreamPosition(after: number, floor: number, tail: number) {
  if (!sequence(after) || !sequence(floor) || !sequence(tail) || floor > tail || after > tail)
    throw new ConversationStreamError('invalid_stream_cursor');
  if (after < floor) throw new ConversationStreamError('cursor_expired');
}

// Copy each supported field. A typed internal object can still carry extra
// properties at runtime; no provider/configuration or historical body leaks.
export function streamMessageReference(message: MessageReference): MessageReference {
  return {
    messageId: message.messageId,
    creationSequence: message.creationSequence,
    versionEventId: message.versionEventId,
    sequence: message.sequence,
    deleted: message.deleted,
    taskId: message.taskId,
    runId: message.runId,
  };
}
export function streamExecutionState(state: ExecutionState): ExecutionState {
  return {
    taskId: state.taskId,
    runId: state.runId,
    attempt: state.attempt,
    taskStatus: state.taskStatus,
    runStatus: state.runStatus,
    bot: {
      id: state.bot.id,
      displayName: state.bot.displayName,
      versionId: state.bot.versionId,
      versionNumber: state.bot.versionNumber,
    },
    executionUser: { id: state.executionUser.id, displayName: state.executionUser.displayName },
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    provider: state.provider
      ? { protocol: state.provider.protocol, modelId: state.provider.modelId }
      : null,
    usage: state.usage
      ? {
          inputTokens: state.usage.inputTokens,
          outputTokens: state.usage.outputTokens,
          estimated: state.usage.estimated === true,
        }
      : null,
    error: state.error,
    output: state.output
      ? {
          messageId: state.output.messageId,
          eventId: state.output.eventId,
          sequence: state.output.sequence,
        }
      : null,
    ...(state.routing
      ? { routing: { algorithm: state.routing.algorithm, reason: state.routing.reason } }
      : {}),
    ...(state.continuation
      ? {
          continuation: {
            origin: state.continuation.origin,
            reason: state.continuation.reason,
            previousRunId: state.continuation.previousRunId,
            previousProvider: {
              protocol: state.continuation.previousProvider.protocol,
              modelId: state.continuation.previousProvider.modelId,
            },
            nextProvider: {
              protocol: state.continuation.nextProvider.protocol,
              modelId: state.continuation.nextProvider.modelId,
            },
            dueAt: state.continuation.dueAt,
            admitted: state.continuation.admitted,
          },
        }
      : {}),
  };
}
function projectPayload(payload: ConversationStreamPayload): ConversationStreamPayload {
  switch (payload.type) {
    case 'message.changed':
      return {
        type: payload.type,
        data: { message: streamMessageReference(payload.data.message) },
      };
    case 'task.run.updated':
      return {
        type: payload.type,
        data: { execution: streamExecutionState(payload.data.execution) },
      };
    case 'conversation.invalidated':
      return { type: payload.type, data: { reason: 'membership' } };
    case 'task.limit.warning': {
      const { taskId, dimension, used, limit, source, soft, hard, body } = payload.data;
      if (
        !uuidPattern.test(taskId) ||
        ![
          'duration',
          'turns',
          'delegationDepth',
          'handoffs',
          'inputTokens',
          'outputTokens',
          'totalTokens',
        ].includes(dimension) ||
        !Number.isSafeInteger(used) ||
        used < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 0 ||
        !['workspace', 'group', 'task', 'run'].includes(source) ||
        typeof soft !== 'boolean' ||
        typeof hard !== 'boolean' ||
        !body ||
        Buffer.byteLength(body) > 512
      )
        throw new ConversationStreamError('conversation_stream_unavailable');
      return {
        type: payload.type,
        data: { taskId, dimension, used, limit, source, soft, hard, body },
      };
    }
    case 'assistant.delta': {
      const { taskId, runId, attempt, startByte, endByte, text } = payload.data;
      if (
        !uuidPattern.test(taskId) ||
        !uuidPattern.test(runId) ||
        !sequence(attempt) ||
        attempt < 1 ||
        !sequence(startByte) ||
        !sequence(endByte) ||
        !text ||
        Buffer.from(text).toString('utf8') !== text ||
        Buffer.byteLength(text) > STREAM_LIMITS.deltaBytes ||
        endByte - startByte !== Buffer.byteLength(text)
      )
        throw new ConversationStreamError('conversation_stream_unavailable');
      return { type: payload.type, data: { taskId, runId, attempt, startByte, endByte, text } };
    }
  }
}
export function encodeConversationStreamEvent(
  scope: ConversationStreamScope,
  position: number,
  occurredAt: Date,
  payload: ConversationStreamPayload,
): string {
  const cursor = encodeConversationStreamCursor(scope, position),
    projected = projectPayload(payload);
  const envelope: ConversationStreamEvent = {
    schemaVersion: 1,
    cursor,
    conversationId: scope.conversationId,
    sequence: position,
    occurredAt: occurredAt.toISOString(),
    ...projected,
  };
  const frame = `id: ${cursor}\nevent: ${projected.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
  if (Buffer.byteLength(frame) > STREAM_LIMITS.frameBytes)
    throw new ConversationStreamError('conversation_stream_unavailable');
  return frame;
}
export function encodeConversationStreamControl(code: ConversationStreamControl): string {
  return `event: stream.control\ndata: ${JSON.stringify({ schemaVersion: 1, code })}\n\n`;
}

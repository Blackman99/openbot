import { parseRoutingSummary, type RoutingSummary } from './routing-contract.js';
import { parseRunContinuation, type RunContinuation } from './task-continuation-contract.js';

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
export type StreamTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'waiting_budget'
  | 'waiting_child';
export type StreamTaskFailure =
  | 'execution_forbidden'
  | 'model_unavailable'
  | 'provider_failed'
  | 'execution_timeout'
  | 'output_limit'
  | 'context_limit'
  | 'worker_stopped'
  | 'worker_interrupted';
export interface ExecutionState {
  taskId: string;
  runId: string;
  attempt: number;
  taskStatus: StreamTaskStatus;
  runStatus: StreamTaskStatus;
  bot: { id: string; displayName: string; versionId: string; versionNumber: number };
  executionUser: { id: string; displayName: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  provider: {
    protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
    modelId: string;
  } | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  error: StreamTaskFailure | null;
  output: { messageId: string; eventId: string; sequence: number } | null;
  routing?: RoutingSummary;
  continuation?: RunContinuation;
}
export interface StreamPreview {
  taskId: string;
  runId: string;
  attempt: number;
  endByte: number;
  text: string;
}
export interface StreamDelta extends StreamPreview {
  startByte: number;
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
interface StreamEventPayloads {
  'message.changed': { message: MessageReference };
  'task.run.updated': { execution: ExecutionState };
  'assistant.delta': StreamDelta;
  'task.limit.warning': ExecutionLimitWarning;
  'conversation.invalidated': { reason: 'membership' };
}
export interface ExecutionLimitWarning {
  taskId: string;
  dimension: 'duration' | 'turns' | 'delegationDepth' | 'handoffs';
  used: number;
  limit: number;
  source: 'workspace' | 'group' | 'task' | 'run';
  soft: boolean;
  hard: boolean;
  body: string;
}
export type ConversationStreamEvent = {
  [K in keyof StreamEventPayloads]: {
    schemaVersion: 1;
    cursor: string;
    conversationId: string;
    sequence: number;
    occurredAt: string;
    type: K;
    data: StreamEventPayloads[K];
  };
}[keyof StreamEventPayloads];
export type ConversationStreamControl =
  | 'authentication_required'
  | 'conversation_forbidden'
  | 'cursor_expired'
  | 'slow_consumer'
  | 'conversation_stream_unavailable';
export type ConversationStreamFrame =
  | { kind: 'event'; event: ConversationStreamEvent }
  | { kind: 'control'; code: ConversationStreamControl };

export const MAX_STREAM_FRAME_BYTES = 256 * 1024;
export const MAX_STREAM_BOOTSTRAP_BYTES = 1024 * 1024;
export const MAX_STREAM_PREVIEW_BYTES = 256 * 1024;
export const MAX_STREAM_PREVIEWS = 8;
export const MAX_STREAM_DELTA_BYTES = 4096;
const encoder = new TextEncoder();
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 32 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && Boolean(value.trim());
}
function utf8Length(value: unknown, maximum: number): number | undefined {
  if (typeof value !== 'string' || value.length > maximum) return undefined;
  const bytes = encoder.encode(value);
  return bytes.byteLength <= maximum && new TextDecoder().decode(bytes) === value
    ? bytes.byteLength
    : undefined;
}
function status(value: unknown): value is StreamTaskStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'paused' ||
    value === 'waiting_budget' ||
    value === 'waiting_child'
  );
}
function failure(value: unknown): value is StreamTaskFailure {
  return (
    typeof value === 'string' &&
    [
      'execution_forbidden',
      'model_unavailable',
      'provider_failed',
      'execution_timeout',
      'output_limit',
      'context_limit',
      'worker_stopped',
      'worker_interrupted',
    ].includes(value)
  );
}
function pageCursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/u.test(value));
}
export function encodeConversationStreamCursor(
  scope: ConversationStreamScope,
  after: number,
): string {
  if (!uuid(scope.workspaceId) || !uuid(scope.conversationId) || !integer(after))
    throw new Error('invalid_stream_cursor');
  return btoa(
    JSON.stringify({
      v: 1,
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      after,
    }),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
// Scope is required at every transport boundary. The reducer may decode its
// already-validated bootstrap cursor without a second source of resource IDs.
export function parseConversationStreamCursor(
  value: unknown,
  scope?: ConversationStreamScope,
): ConversationStreamCursor | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(value)) return undefined;
  try {
    const decoded: unknown = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    if (
      !keys(decoded, 'after,conversationId,v,workspaceId') ||
      decoded.v !== 1 ||
      !uuid(decoded.workspaceId) ||
      !uuid(decoded.conversationId) ||
      !integer(decoded.after) ||
      (scope &&
        (scope.workspaceId !== decoded.workspaceId ||
          scope.conversationId !== decoded.conversationId))
    )
      return undefined;
    const cursor: ConversationStreamCursor = {
      v: 1,
      workspaceId: decoded.workspaceId,
      conversationId: decoded.conversationId,
      after: decoded.after,
    };
    return encodeConversationStreamCursor(cursor, cursor.after) === value ? cursor : undefined;
  } catch {
    return undefined;
  }
}
export function parseMessageReference(value: unknown): MessageReference | undefined {
  if (
    !keys(value, 'creationSequence,deleted,messageId,runId,sequence,taskId,versionEventId') ||
    !uuid(value.messageId) ||
    !uuid(value.versionEventId) ||
    !integer(value.creationSequence, 1) ||
    !integer(value.sequence, value.creationSequence) ||
    typeof value.deleted !== 'boolean' ||
    !((value.taskId === null && value.runId === null) || (uuid(value.taskId) && uuid(value.runId)))
  )
    return undefined;
  return {
    messageId: value.messageId,
    creationSequence: value.creationSequence,
    versionEventId: value.versionEventId,
    sequence: value.sequence,
    deleted: value.deleted,
    taskId: value.taskId,
    runId: value.runId,
  };
}
export function parseExecutionState(value: unknown): ExecutionState | undefined {
  if (
    (!keys(
      value,
      'attempt,bot,createdAt,error,executionUser,finishedAt,output,provider,runId,runStatus,startedAt,taskId,taskStatus,usage',
    ) &&
      !keys(
        value,
        'attempt,bot,createdAt,error,executionUser,finishedAt,output,provider,routing,runId,runStatus,startedAt,taskId,taskStatus,usage',
      ) &&
      !keys(
        value,
        'attempt,bot,continuation,createdAt,error,executionUser,finishedAt,output,provider,runId,runStatus,startedAt,taskId,taskStatus,usage',
      ) &&
      !keys(
        value,
        'attempt,bot,continuation,createdAt,error,executionUser,finishedAt,output,provider,routing,runId,runStatus,startedAt,taskId,taskStatus,usage',
      )) ||
    !uuid(value.taskId) ||
    !uuid(value.runId) ||
    !integer(value.attempt, 1) ||
    !status(value.taskStatus) ||
    value.runStatus !== value.taskStatus ||
    !date(value.createdAt) ||
    (value.startedAt !== null && (!date(value.startedAt) || value.startedAt < value.createdAt)) ||
    (value.finishedAt !== null &&
      (!date(value.finishedAt) || value.finishedAt < (value.startedAt ?? value.createdAt))) ||
    !keys(value.bot, 'displayName,id,versionId,versionNumber') ||
    !uuid(value.bot.id) ||
    !uuid(value.bot.versionId) ||
    !integer(value.bot.versionNumber, 1) ||
    !text(value.bot.displayName, 100) ||
    !keys(value.executionUser, 'displayName,id') ||
    !uuid(value.executionUser.id) ||
    !text(value.executionUser.displayName, 200) ||
    (value.error !== null && !failure(value.error))
  )
    return undefined;
  const routing = 'routing' in value ? parseRoutingSummary(value.routing) : undefined;
  if ('routing' in value && !routing) return undefined;
  let provider: ExecutionState['provider'] = null,
    usage: ExecutionState['usage'] = null,
    output: ExecutionState['output'] = null;
  if (value.provider !== null) {
    const p = value.provider;
    if (
      !keys(p, 'modelId,protocol') ||
      !text(p.modelId, 256) ||
      (p.protocol !== 'openai-chat' &&
        p.protocol !== 'openai-responses' &&
        p.protocol !== 'anthropic-messages')
    )
      return undefined;
    provider = { protocol: p.protocol, modelId: p.modelId };
  }
  if (value.usage !== null) {
    if (
      !keys(value.usage, 'inputTokens,outputTokens') ||
      !integer(value.usage.inputTokens) ||
      !integer(value.usage.outputTokens)
    )
      return undefined;
    usage = { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens };
  }
  if (value.output !== null) {
    if (
      !keys(value.output, 'eventId,messageId,sequence') ||
      !uuid(value.output.messageId) ||
      !uuid(value.output.eventId) ||
      !integer(value.output.sequence, 1)
    )
      return undefined;
    output = {
      messageId: value.output.messageId,
      eventId: value.output.eventId,
      sequence: value.output.sequence,
    };
  }
  if (
    value.taskStatus === 'queued' &&
    (value.startedAt !== null ||
      value.finishedAt !== null ||
      provider !== null ||
      usage !== null ||
      value.error !== null ||
      output !== null)
  )
    return undefined;
  if (
    value.taskStatus === 'running' &&
    (value.startedAt === null ||
      value.finishedAt !== null ||
      provider === null ||
      value.error !== null ||
      output !== null)
  )
    return undefined;
  if (
    value.taskStatus === 'completed' &&
    (value.startedAt === null ||
      value.finishedAt === null ||
      provider === null ||
      value.error !== null ||
      output === null)
  )
    return undefined;
  if (
    value.taskStatus === 'failed' &&
    (value.finishedAt === null || value.error === null || output !== null)
  )
    return undefined;
  if (
    (value.taskStatus === 'cancelled' || value.taskStatus === 'paused') &&
    (value.finishedAt === null ||
      value.error !== null ||
      output !== null ||
      (value.startedAt !== null && provider === null))
  )
    return undefined;
  if (value.startedAt === null && (provider !== null || usage !== null)) return undefined;
  let continuation: ExecutionState['continuation'];
  if ('continuation' in value) {
    continuation = parseRunContinuation(value.continuation);
    if (!continuation) return undefined;
  }
  return {
    taskId: value.taskId,
    runId: value.runId,
    attempt: value.attempt,
    taskStatus: value.taskStatus,
    runStatus: value.taskStatus,
    bot: {
      id: value.bot.id,
      displayName: value.bot.displayName,
      versionId: value.bot.versionId,
      versionNumber: value.bot.versionNumber,
    },
    executionUser: { id: value.executionUser.id, displayName: value.executionUser.displayName },
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    provider,
    usage,
    error: value.error,
    output,
    ...(routing ? { routing } : {}),
    ...(continuation ? { continuation } : {}),
  };
}
function preview(value: unknown): StreamPreview | undefined {
  if (
    !keys(value, 'attempt,endByte,runId,taskId,text') ||
    !uuid(value.taskId) ||
    !uuid(value.runId) ||
    !integer(value.attempt, 1) ||
    !integer(value.endByte) ||
    typeof value.text !== 'string' ||
    utf8Length(value.text, MAX_STREAM_PREVIEW_BYTES) !== value.endByte
  )
    return undefined;
  return {
    taskId: value.taskId,
    runId: value.runId,
    attempt: value.attempt,
    endByte: value.endByte,
    text: value.text,
  };
}
export function parseConversationStreamEvent(
  value: unknown,
  scope: ConversationStreamScope,
): ConversationStreamEvent | undefined {
  if (
    !keys(value, 'conversationId,cursor,data,occurredAt,schemaVersion,sequence,type') ||
    value.schemaVersion !== 1 ||
    value.conversationId !== scope.conversationId ||
    !integer(value.sequence, 1) ||
    !date(value.occurredAt) ||
    typeof value.cursor !== 'string' ||
    parseConversationStreamCursor(value.cursor, scope)?.after !== value.sequence
  )
    return undefined;
  const header = {
    schemaVersion: 1 as const,
    cursor: value.cursor,
    conversationId: scope.conversationId,
    sequence: value.sequence,
    occurredAt: value.occurredAt,
  };
  const data = value.data;
  if (value.type === 'message.changed' && keys(data, 'message')) {
    const message = parseMessageReference(data.message);
    if (message && message.creationSequence <= value.sequence && message.sequence >= value.sequence)
      return { ...header, type: 'message.changed', data: { message } };
  }
  if (value.type === 'task.run.updated' && keys(data, 'execution')) {
    const execution = parseExecutionState(data.execution);
    if (execution && (execution.output === null || execution.output.sequence < value.sequence))
      return { ...header, type: 'task.run.updated', data: { execution } };
  }
  if (
    value.type === 'conversation.invalidated' &&
    keys(data, 'reason') &&
    data.reason === 'membership'
  )
    return { ...header, type: 'conversation.invalidated', data: { reason: 'membership' } };
  if (
    value.type === 'assistant.delta' &&
    keys(data, 'attempt,endByte,runId,startByte,taskId,text') &&
    uuid(data.taskId) &&
    uuid(data.runId) &&
    integer(data.attempt, 1) &&
    integer(data.startByte) &&
    integer(data.endByte, 1) &&
    data.endByte > data.startByte &&
    typeof data.text === 'string' &&
    utf8Length(data.text, MAX_STREAM_DELTA_BYTES) === data.endByte - data.startByte
  )
    return {
      ...header,
      type: 'assistant.delta',
      data: {
        taskId: data.taskId,
        runId: data.runId,
        attempt: data.attempt,
        startByte: data.startByte,
        endByte: data.endByte,
        text: data.text,
      },
    };
  if (
    value.type === 'task.limit.warning' &&
    keys(data, 'body,dimension,hard,limit,soft,source,taskId,used') &&
    uuid(data.taskId) &&
    (data.dimension === 'duration' ||
      data.dimension === 'turns' ||
      data.dimension === 'delegationDepth' ||
      data.dimension === 'handoffs') &&
    integer(data.used) &&
    integer(data.limit) &&
    (data.source === 'workspace' ||
      data.source === 'group' ||
      data.source === 'task' ||
      data.source === 'run') &&
    data.soft === true &&
    typeof data.hard === 'boolean' &&
    text(data.body, 512)
  )
    return {
      ...header,
      type: 'task.limit.warning',
      data: {
        taskId: data.taskId,
        dimension: data.dimension,
        used: data.used,
        limit: data.limit,
        source: data.source,
        soft: data.soft,
        hard: data.hard,
        body: data.body,
      },
    };
  return undefined;
}
export function parseConversationStreamBootstrap(
  input: string | Uint8Array,
  scope: ConversationStreamScope,
): ConversationStreamBootstrap | undefined {
  try {
    if (
      typeof input === 'string'
        ? utf8Length(input, MAX_STREAM_BOOTSTRAP_BYTES) === undefined
        : input.byteLength > MAX_STREAM_BOOTSTRAP_BYTES
    )
      return undefined;
    const value: unknown = JSON.parse(
      typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input),
    );
    if (
      !keys(
        value,
        'conversationId,cursor,executions,messages,nextMessageCursor,nextTaskCursor,previews,previewsTruncated,schemaVersion',
      ) ||
      value.schemaVersion !== 1 ||
      value.conversationId !== scope.conversationId ||
      typeof value.cursor !== 'string' ||
      !pageCursor(value.nextMessageCursor) ||
      !pageCursor(value.nextTaskCursor) ||
      typeof value.previewsTruncated !== 'boolean' ||
      !Array.isArray(value.messages) ||
      value.messages.length > 20 ||
      !Array.isArray(value.executions) ||
      value.executions.length > 20 ||
      !Array.isArray(value.previews) ||
      value.previews.length > MAX_STREAM_PREVIEWS
    )
      return undefined;
    const cursor = parseConversationStreamCursor(value.cursor, scope);
    if (!cursor) return undefined;
    const messages: MessageReference[] = [],
      executions: ExecutionState[] = [],
      previews: StreamPreview[] = [];
    for (const item of value.messages) {
      const message = parseMessageReference(item);
      if (
        !message ||
        message.sequence > cursor.after ||
        messages.some((known) => known.messageId === message.messageId) ||
        (messages.at(-1)?.creationSequence ?? 0) >= message.creationSequence
      )
        return undefined;
      messages.push(message);
    }
    for (const item of value.executions) {
      const execution = parseExecutionState(item);
      if (
        !execution ||
        (execution.output !== null && execution.output.sequence > cursor.after) ||
        executions.some(
          (known) => known.runId === execution.runId || known.taskId === execution.taskId,
        )
      )
        return undefined;
      executions.push(execution);
    }
    let bytes = 0;
    for (const item of value.previews) {
      const selected = preview(item);
      if (
        !selected ||
        previews.some(
          (known) => known.runId === selected.runId || known.taskId === selected.taskId,
        ) ||
        (bytes += selected.endByte) > MAX_STREAM_PREVIEW_BYTES
      )
        return undefined;
      const execution = executions.find((known) => known.runId === selected.runId);
      if (
        execution &&
        (execution.taskId !== selected.taskId ||
          execution.attempt !== selected.attempt ||
          execution.runStatus !== 'running')
      )
        return undefined;
      previews.push(selected);
    }
    return {
      schemaVersion: 1,
      cursor: value.cursor,
      conversationId: scope.conversationId,
      messages,
      nextMessageCursor: value.nextMessageCursor,
      executions,
      nextTaskCursor: value.nextTaskCursor,
      previews,
      previewsTruncated: value.previewsTruncated,
    };
  } catch {
    return undefined;
  }
}

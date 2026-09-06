import { parseRoutingSummary, type RoutingSummary } from '../routing-contract.js';
import { parseRunContinuation, type RunContinuation } from '../task-continuation-contract.js';
import {
  isConversationUuid,
  isConversationCursor,
  type MessageReceipt,
} from './conversation-api.js';
export type {
  ContinuationOrigin,
  ContinuationReason,
  RunContinuation,
  SafeModelSnapshot,
} from '../task-continuation-contract.js';
export {
  continuationReasons,
  parseRunContinuation,
  parseSafeModelSnapshot,
} from '../task-continuation-contract.js';
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'waiting_budget'
  | 'waiting_child';
export const taskErrorCodes = [
  'execution_forbidden',
  'model_unavailable',
  'provider_failed',
  'execution_timeout',
  'output_limit',
  'context_limit',
  'worker_stopped',
  'worker_interrupted',
] as const;
export type TaskErrorCode = (typeof taskErrorCodes)[number];
export interface TaskRun {
  id: string;
  attempt: number;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  provider: null | {
    protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
    modelId: string;
  };
  usage: null | { inputTokens: number; outputTokens: number };
  error: TaskErrorCode | null;
  output: MessageReceipt | null;
  continuation?: RunContinuation;
}
export interface TaskView {
  id: string;
  conversationId: string;
  status: TaskStatus;
  createdAt: string;
  bot: { id: string; name: string; versionId: string; versionNumber: number };
  executionUser: { id: string; displayName: string };
  groupGrantId: string | null;
  routing?: RoutingSummary;
  trigger: MessageReceipt;
  runCount: number;
  olderRunsCursor: string | null;
  runs: TaskRun[];
}
export interface TaskPage {
  conversationId: string;
  tasks: TaskView[];
  nextCursor: string | null;
}
export function taskKeys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
export function taskText(value: unknown, max: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
}
export function taskInteger(value: unknown, minimum = 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function status(value: unknown): value is TaskStatus {
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
function errorCode(value: unknown): value is TaskErrorCode {
  return typeof value === 'string' && taskErrorCodes.some((code) => code === value);
}
export function taskDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function receipt(value: unknown): MessageReceipt | undefined {
  return taskKeys(value, 'eventId,messageId,sequence') &&
    isConversationUuid(value.eventId) &&
    isConversationUuid(value.messageId) &&
    taskInteger(value.sequence)
    ? {
        eventId: value.eventId.toLowerCase(),
        messageId: value.messageId.toLowerCase(),
        sequence: value.sequence,
      }
    : undefined;
}
export function parseTaskRun(value: unknown, createdAt?: string): TaskRun | undefined {
  if (
    (!taskKeys(
      value,
      'attempt,createdAt,error,finishedAt,id,output,provider,startedAt,status,usage',
    ) &&
      !taskKeys(
        value,
        'attempt,continuation,createdAt,error,finishedAt,id,output,provider,startedAt,status,usage',
      )) ||
    !isConversationUuid(value.id) ||
    !taskInteger(value.attempt) ||
    value.attempt > 2147483647 ||
    !status(value.status) ||
    !taskDate(value.createdAt) ||
    (createdAt !== undefined && value.createdAt < createdAt) ||
    (value.startedAt !== null &&
      (!taskDate(value.startedAt) || value.startedAt < value.createdAt)) ||
    (value.finishedAt !== null &&
      (!taskDate(value.finishedAt) || value.finishedAt < (value.startedAt ?? value.createdAt))) ||
    (value.error !== null && !errorCode(value.error))
  )
    return undefined;
  let provider: TaskRun['provider'] = null,
    usage: TaskRun['usage'] = null;
  if (value.provider !== null) {
    const p = value.provider;
    if (
      !taskKeys(p, 'modelId,protocol') ||
      !taskText(p.modelId, 256) ||
      (p.protocol !== 'openai-chat' &&
        p.protocol !== 'openai-responses' &&
        p.protocol !== 'anthropic-messages')
    )
      return undefined;
    provider = { protocol: p.protocol, modelId: p.modelId };
  }
  if (value.usage !== null) {
    if (
      !taskKeys(value.usage, 'inputTokens,outputTokens') ||
      !taskInteger(value.usage.inputTokens, 0) ||
      !taskInteger(value.usage.outputTokens, 0)
    )
      return undefined;
    usage = { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens };
  }
  const output = value.output === null ? null : receipt(value.output);
  if (output === undefined) return undefined;
  if (
    value.status === 'queued' &&
    (value.startedAt !== null ||
      value.finishedAt !== null ||
      provider !== null ||
      usage !== null ||
      value.error !== null ||
      output !== null)
  )
    return undefined;
  if (
    value.status === 'running' &&
    (value.startedAt === null ||
      value.finishedAt !== null ||
      provider === null ||
      value.error !== null ||
      output !== null)
  )
    return undefined;
  if (
    value.status === 'completed' &&
    (value.startedAt === null ||
      value.finishedAt === null ||
      provider === null ||
      value.error !== null ||
      output === null)
  )
    return undefined;
  if (
    value.status === 'failed' &&
    (value.finishedAt === null || value.error === null || output !== null)
  )
    return undefined;
  if (
    (value.status === 'cancelled' || value.status === 'paused') &&
    (value.finishedAt === null ||
      value.error !== null ||
      output !== null ||
      (value.startedAt !== null && provider === null))
  )
    return undefined;
  if (value.startedAt === null && (provider !== null || usage !== null)) return undefined;
  let continuation: TaskRun['continuation'];
  if ('continuation' in value) {
    continuation = parseRunContinuation(value.continuation);
    if (!continuation) return undefined;
  }
  return {
    id: value.id.toLowerCase(),
    attempt: value.attempt,
    status: value.status,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    provider,
    usage,
    error: value.error,
    output,
    ...(continuation ? { continuation } : {}),
  };
}
export function parseTask(value: unknown, conversationId: string): TaskView | undefined {
  if (
    (!taskKeys(
      value,
      'bot,conversationId,createdAt,executionUser,groupGrantId,id,olderRunsCursor,runCount,runs,status,trigger',
    ) &&
      !taskKeys(
        value,
        'bot,conversationId,createdAt,executionUser,groupGrantId,id,olderRunsCursor,routing,runCount,runs,status,trigger',
      )) ||
    !isConversationUuid(value.id) ||
    !isConversationUuid(value.conversationId) ||
    value.conversationId.toLowerCase() !== conversationId.toLowerCase() ||
    !status(value.status) ||
    !taskDate(value.createdAt) ||
    !taskKeys(value.bot, 'id,name,versionId,versionNumber') ||
    !isConversationUuid(value.bot.id) ||
    !isConversationUuid(value.bot.versionId) ||
    !taskInteger(value.bot.versionNumber) ||
    !taskText(value.bot.name, 100) ||
    !taskKeys(value.executionUser, 'displayName,id') ||
    !isConversationUuid(value.executionUser.id) ||
    !taskText(value.executionUser.displayName, 200) ||
    (value.groupGrantId !== null && !isConversationUuid(value.groupGrantId)) ||
    !taskInteger(value.runCount) ||
    value.runCount > 2147483647 ||
    (value.olderRunsCursor !== null && !isConversationCursor(value.olderRunsCursor)) ||
    (value.runCount === 1
      ? value.olderRunsCursor !== null
      : !isConversationCursor(value.olderRunsCursor)) ||
    !Array.isArray(value.runs) ||
    value.runs.length !== 1
  )
    return undefined;
  let routing: TaskView['routing'];
  if ('routing' in value) {
    routing = parseRoutingSummary(value.routing);
    if (value.groupGrantId === null || routing === undefined) return undefined;
  }
  const trigger = receipt(value.trigger),
    attempt = parseTaskRun(value.runs[0], value.createdAt);
  if (
    !trigger ||
    !attempt ||
    (value.status === 'waiting_budget'
      ? !['queued', 'failed', 'paused'].includes(attempt.status)
      : attempt.status !== value.status) ||
    attempt.attempt !== value.runCount ||
    (attempt.output !== null &&
      (attempt.output.sequence <= trigger.sequence ||
        attempt.output.messageId === trigger.messageId ||
        attempt.output.eventId === trigger.eventId))
  )
    return undefined;
  return {
    id: value.id.toLowerCase(),
    conversationId: value.conversationId.toLowerCase(),
    status: value.status,
    createdAt: value.createdAt,
    bot: {
      id: value.bot.id.toLowerCase(),
      name: value.bot.name,
      versionId: value.bot.versionId.toLowerCase(),
      versionNumber: value.bot.versionNumber,
    },
    executionUser: {
      id: value.executionUser.id.toLowerCase(),
      displayName: value.executionUser.displayName,
    },
    groupGrantId: value.groupGrantId === null ? null : value.groupGrantId.toLowerCase(),
    runCount: value.runCount,
    olderRunsCursor: value.olderRunsCursor,
    ...(routing === undefined ? {} : { routing }),
    trigger,
    runs: [attempt],
  };
}

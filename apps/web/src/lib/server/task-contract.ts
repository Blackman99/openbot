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
  | 'waiting_child'
  | 'waiting_input'
  | 'waiting_approval';
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
  usage: null | { inputTokens: number; outputTokens: number; estimated: boolean };
  price?:
    | { kind: 'unpriced' }
    | {
        kind: 'priced';
        versionId: string;
        inputMicrosPerMillion: number;
        outputMicrosPerMillion: number;
        costMicros: number | null;
      };
  error: TaskErrorCode | null;
  output: MessageReceipt | null;
  continuation?: RunContinuation;
}
export type TokenBudgetLayer = 'workspace' | 'group' | 'task' | 'run';
export interface TokenBudgetCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface TokenBudgetRemaining {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
export interface TokenBudgetScopeView {
  kind: TokenBudgetLayer;
  used: TokenBudgetCounts;
  reserved: TokenBudgetCounts;
  remaining: TokenBudgetRemaining;
}
export type CostBudgetLayer = 'workspace' | 'group' | 'task';
export interface CostBudgetScopeView {
  kind: CostBudgetLayer;
  usedMicros: number;
  reservedMicros: number;
  remainingMicros: number;
}
export interface HumanInputSchema {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, { type: 'string' | 'number' | 'boolean' }>;
  required: string[];
}
export interface TaskHumanRequest {
  id: string;
  kind: 'input' | 'approval';
  prompt?: string;
  responseSchema?: HumanInputSchema;
  summary?: string;
  createdAt: string;
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
  tokenBudgets?: TokenBudgetScopeView[];
  costBudgets?: CostBudgetScopeView[];
  humanRequest?: TaskHumanRequest;
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
    value === 'waiting_child' ||
    value === 'waiting_input' ||
    value === 'waiting_approval'
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
function parseTokenBudgetCounts(value: unknown): TokenBudgetCounts | undefined {
  if (!taskKeys(value, 'inputTokens,outputTokens,totalTokens')) return undefined;
  if (
    !taskInteger(value.inputTokens, 0) ||
    !taskInteger(value.outputTokens, 0) ||
    !taskInteger(value.totalTokens, 0) ||
    value.totalTokens !== value.inputTokens + value.outputTokens
  )
    return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

function parseTokenBudgetRemaining(value: unknown): TokenBudgetRemaining | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const remaining: TokenBudgetRemaining = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (!(key in value)) continue;
    const count = (value as Record<string, unknown>)[key];
    if (!taskInteger(count, 0)) return undefined;
    remaining[key] = count;
  }
  const keys = Object.keys(value).sort().join(',');
  const expected = Object.keys(remaining).sort().join(',');
  if (!expected || keys !== expected) return undefined;
  return remaining;
}

export function parseTokenBudgetScope(value: unknown): TokenBudgetScopeView | undefined {
  if (!taskKeys(value, 'kind,remaining,reserved,used')) return undefined;
  if (
    value.kind !== 'workspace' &&
    value.kind !== 'group' &&
    value.kind !== 'task' &&
    value.kind !== 'run'
  )
    return undefined;
  const used = parseTokenBudgetCounts(value.used);
  const reserved = parseTokenBudgetCounts(value.reserved);
  const remaining = parseTokenBudgetRemaining(value.remaining);
  if (!used || !reserved || !remaining) return undefined;
  return { kind: value.kind, used, reserved, remaining };
}

function parseTokenBudgets(value: unknown): TokenBudgetScopeView[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const scopes: TokenBudgetScopeView[] = [];
  for (const item of value) {
    const scope = parseTokenBudgetScope(item);
    if (!scope) return undefined;
    scopes.push(scope);
  }
  return scopes;
}

function parseCostBudgets(value: unknown): CostBudgetScopeView[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const scopes: CostBudgetScopeView[] = [];
  for (const item of value) {
    if (
      !taskKeys(item, 'kind,remainingMicros,reservedMicros,usedMicros') ||
      (item.kind !== 'workspace' && item.kind !== 'group' && item.kind !== 'task') ||
      !taskInteger(item.usedMicros, 0) ||
      !taskInteger(item.reservedMicros, 0) ||
      !taskInteger(item.remainingMicros, 0)
    )
      return undefined;
    scopes.push({
      kind: item.kind,
      usedMicros: item.usedMicros,
      reservedMicros: item.reservedMicros,
      remainingMicros: item.remainingMicros,
    });
  }
  return scopes;
}

function parseTaskUsage(value: unknown): TaskRun['usage'] | undefined {
  if (value === null) return null;
  if (
    !taskKeys(value, 'inputTokens,outputTokens') &&
    !taskKeys(value, 'estimated,inputTokens,outputTokens')
  )
    return undefined;
  if (!taskInteger(value.inputTokens, 0) || !taskInteger(value.outputTokens, 0)) return undefined;
  const estimated = 'estimated' in value ? value.estimated : false;
  if (typeof estimated !== 'boolean') return undefined;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, estimated };
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
function parseRunPrice(value: unknown): TaskRun['price'] | undefined {
  if (!taskKeys(value, 'kind') || value.kind !== 'unpriced') {
    if (
      !taskKeys(value, 'costMicros,inputMicrosPerMillion,kind,outputMicrosPerMillion,versionId') ||
      value.kind !== 'priced' ||
      !isConversationUuid(value.versionId) ||
      !taskInteger(value.inputMicrosPerMillion, 0) ||
      !taskInteger(value.outputMicrosPerMillion, 0) ||
      (value.costMicros !== null && !taskInteger(value.costMicros, 0))
    )
      return undefined;
    return {
      kind: 'priced',
      versionId: value.versionId.toLowerCase(),
      inputMicrosPerMillion: value.inputMicrosPerMillion,
      outputMicrosPerMillion: value.outputMicrosPerMillion,
      costMicros: value.costMicros,
    };
  }
  return { kind: 'unpriced' };
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
      ) &&
      !taskKeys(
        value,
        'attempt,createdAt,error,finishedAt,id,output,price,provider,startedAt,status,usage',
      ) &&
      !taskKeys(
        value,
        'attempt,continuation,createdAt,error,finishedAt,id,output,price,provider,startedAt,status,usage',
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
    const parsed = parseTaskUsage(value.usage);
    if (!parsed) return undefined;
    usage = parsed;
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
    (value.status === 'cancelled' ||
      value.status === 'paused' ||
      value.status === 'waiting_input' ||
      value.status === 'waiting_approval') &&
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
  let price: TaskRun['price'];
  if ('price' in value) {
    price = parseRunPrice(value.price);
    if (!price) return undefined;
    if (value.status === 'queued') return undefined;
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
    ...(price ? { price } : {}),
  };
}
function matchesTaskViewKeys(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const extras = ['costBudgets', 'humanRequest', 'routing', 'tokenBudgets'].filter(
    (key) => key in value,
  );
  return taskKeys(
    value,
    [
      'bot',
      'conversationId',
      ...extras.filter((key) => key === 'costBudgets'),
      'createdAt',
      'executionUser',
      'groupGrantId',
      ...extras.filter((key) => key === 'humanRequest'),
      'id',
      'olderRunsCursor',
      ...extras.filter((key) => key === 'routing'),
      'runCount',
      'runs',
      'status',
      ...extras.filter((key) => key === 'tokenBudgets'),
      'trigger',
    ].join(','),
  );
}

function parseHumanInputSchema(value: unknown): HumanInputSchema | undefined {
  if (!taskKeys(value, 'additionalProperties,properties,required,type')) return undefined;
  if (
    value.type !== 'object' ||
    value.additionalProperties !== false ||
    typeof value.properties !== 'object' ||
    value.properties === null ||
    Array.isArray(value.properties)
  )
    return undefined;
  if (!Array.isArray(value.required) || value.required.some((item) => typeof item !== 'string'))
    return undefined;
  const names = Object.keys(value.properties);
  if (!names.length || names.length > 16) return undefined;
  const properties: HumanInputSchema['properties'] = {};
  for (const name of names) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) return undefined;
    const field = (value.properties as Record<string, unknown>)[name];
    if (!taskKeys(field, 'type')) return undefined;
    if (field.type !== 'string' && field.type !== 'number' && field.type !== 'boolean')
      return undefined;
    properties[name] = { type: field.type };
  }
  if (new Set(value.required).size !== value.required.length) return undefined;
  if (value.required.some((name) => !properties[name as string])) return undefined;
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: value.required as string[],
  };
}

function parseHumanRequest(value: unknown): TaskHumanRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'input') {
    if (!taskKeys(record, 'createdAt,id,kind,prompt,responseSchema')) return undefined;
    if (
      !isConversationUuid(record.id) ||
      !taskText(record.prompt, 8000) ||
      !taskDate(record.createdAt)
    )
      return undefined;
    const responseSchema = parseHumanInputSchema(record.responseSchema);
    if (!responseSchema) return undefined;
    return {
      id: record.id.toLowerCase(),
      kind: 'input',
      prompt: record.prompt,
      responseSchema,
      createdAt: record.createdAt,
    };
  }
  if (record.kind === 'approval') {
    if (!taskKeys(record, 'createdAt,id,kind,summary')) return undefined;
    if (
      !isConversationUuid(record.id) ||
      !taskText(record.summary, 8000) ||
      !taskDate(record.createdAt)
    )
      return undefined;
    return {
      id: record.id.toLowerCase(),
      kind: 'approval',
      summary: record.summary,
      createdAt: record.createdAt,
    };
  }
  return undefined;
}

export function parseTask(value: unknown, conversationId: string): TaskView | undefined {
  if (
    !matchesTaskViewKeys(value) ||
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
  let tokenBudgets: TaskView['tokenBudgets'];
  if ('tokenBudgets' in value) {
    tokenBudgets = parseTokenBudgets(value.tokenBudgets);
    if (!tokenBudgets) return undefined;
  }
  let costBudgets: TaskView['costBudgets'];
  if ('costBudgets' in value) {
    costBudgets = parseCostBudgets(value.costBudgets);
    if (!costBudgets) return undefined;
  }
  let humanRequest: TaskView['humanRequest'];
  if ('humanRequest' in value) {
    humanRequest = parseHumanRequest(value.humanRequest);
    if (!humanRequest) return undefined;
  }
  if (value.status === 'waiting_input') {
    if (!humanRequest || humanRequest.kind !== 'input') return undefined;
  } else if (value.status === 'waiting_approval') {
    if (!humanRequest || humanRequest.kind !== 'approval') return undefined;
  } else if (humanRequest) return undefined;
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
    ...(tokenBudgets ? { tokenBudgets } : {}),
    ...(costBudgets ? { costBudgets } : {}),
    ...(humanRequest ? { humanRequest } : {}),
    runs: [attempt],
  };
}

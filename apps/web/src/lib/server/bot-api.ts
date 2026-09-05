import { SESSION_COOKIE_NAME } from './auth-api.js';
export type BotScope = { kind: 'personal' | 'workspace'; id: string };
export interface BotLimits {
  maxTotalTokens: number;
  maxDurationSeconds: number;
  maxTurns: number;
  maxDelegationDepth: number;
}
export interface BotRetryPolicy {
  maxAttemptsPerModel: number;
  maxRunsPerChain: number;
}
export interface BotConfiguration {
  avatarObjectId?: string | null;
  name: string;
  roleDescription: string;
  description: string;
  instructions: string;
  modelBinding: { scope: BotScope; connectionId: string; modelId: string };
  limits: BotLimits;
  retryPolicy?: BotRetryPolicy;
  fallbackBindings?: BotConfiguration['modelBinding'][];
}
export type BotInput = Omit<BotConfiguration, 'description' | 'limits' | 'avatarObjectId'> & {
  description?: string;
  limits?: Partial<BotLimits>;
};
export type BindingUnavailableReason =
  'disabled' | 'binding-changed' | 'capability-unavailable' | 'not-accessible';
export type BindingStatus =
  | { state: 'ready'; chatOnly: boolean }
  | { state: 'unavailable'; reason: BindingUnavailableReason };
export type BotLifecycleState = 'active' | 'archived' | 'deleted';
export type BotListView = 'default' | 'deleted' | 'usable';
export interface BotSummary {
  lifecycleState: BotLifecycleState;
  avatarVersionId?: string;
  id: string;
  workspaceId: string;
  visibility: 'private' | 'workspace';
  accessRole: 'owner' | 'editor' | 'user' | null;
  name: string;
  roleDescription: string;
  description: string;
  bindingStatus: BindingStatus;
}
export interface BotDetail extends BotSummary {
  currentVersion: {
    id: string;
    number: number;
    author: { id: string; displayName: string };
    createdAt: string;
    rationale: string;
    configuration: BotConfiguration;
  };
}
export type BotResult<T> =
  | { status: 'available'; value: T }
  | { status: 'anonymous' | 'forbidden' | 'invalid' | 'unavailable' }
  | { status: 'model-unavailable'; reason: BindingUnavailableReason };
export function isBotUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}
function keys(
  value: unknown,
  expected: string,
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value)
      .filter((key) => !optional.includes(key))
      .sort()
      .join(',') === expected
  );
}
function bounded(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function reason(value: unknown): value is BindingUnavailableReason {
  return (
    value === 'disabled' ||
    value === 'binding-changed' ||
    value === 'capability-unavailable' ||
    value === 'not-accessible'
  );
}
export function bindingStatus(value: unknown): BindingStatus | undefined {
  if (
    keys(value, 'chatOnly,state') &&
    value.state === 'ready' &&
    typeof value.chatOnly === 'boolean'
  )
    return { state: 'ready', chatOnly: value.chatOnly };
  if (keys(value, 'reason,state') && value.state === 'unavailable' && reason(value.reason))
    return { state: 'unavailable', reason: value.reason };
  return undefined;
}
function parseBinding(
  value: unknown,
  workspaceId: string,
): BotConfiguration['modelBinding'] | undefined {
  if (
    !keys(value, 'connectionId,modelId,scope') ||
    !keys(value.scope, 'id,kind') ||
    !isBotUuid(value.scope.id) ||
    (value.scope.kind !== 'workspace' && value.scope.kind !== 'personal') ||
    (value.scope.kind === 'workspace' && value.scope.id.toLowerCase() !== workspaceId) ||
    !isBotUuid(value.connectionId) ||
    !bounded(value.modelId, 1, 256)
  )
    return undefined;
  return {
    scope: { kind: value.scope.kind, id: value.scope.id.toLowerCase() },
    connectionId: value.connectionId.toLowerCase(),
    modelId: value.modelId,
  };
}
export function parseBotConfiguration(
  value: unknown,
  workspaceId: string,
): BotConfiguration | undefined {
  if (
    !keys(value, 'description,instructions,limits,modelBinding,name,roleDescription', [
      'avatarObjectId',
      'retryPolicy',
      'fallbackBindings',
    ]) ||
    ('avatarObjectId' in value &&
      value.avatarObjectId !== null &&
      !isBotUuid(value.avatarObjectId)) ||
    !bounded(value.name, 1, 100) ||
    !bounded(value.roleDescription, 1, 200) ||
    !bounded(value.description, 0, 2000) ||
    !bounded(value.instructions, 1, 32000) ||
    !keys(value.limits, 'maxDelegationDepth,maxDurationSeconds,maxTotalTokens,maxTurns') ||
    !integer(value.limits.maxTotalTokens, 1, 1000000) ||
    !integer(value.limits.maxDurationSeconds, 1, 3600) ||
    !integer(value.limits.maxTurns, 1, 100) ||
    !integer(value.limits.maxDelegationDepth, 0, 8)
  )
    return undefined;
  const modelBinding = parseBinding(value.modelBinding, workspaceId);
  if (!modelBinding) return undefined;
  let retryPolicy: BotRetryPolicy | undefined;
  if ('retryPolicy' in value) {
    if (
      !keys(value.retryPolicy, 'maxAttemptsPerModel,maxRunsPerChain') ||
      !integer(value.retryPolicy.maxAttemptsPerModel, 1, 3) ||
      !integer(value.retryPolicy.maxRunsPerChain, 1, 4)
    )
      return undefined;
    retryPolicy = {
      maxAttemptsPerModel: value.retryPolicy.maxAttemptsPerModel,
      maxRunsPerChain: value.retryPolicy.maxRunsPerChain,
    };
  }
  let fallbackBindings: BotConfiguration['modelBinding'][] | undefined;
  if ('fallbackBindings' in value) {
    if (!Array.isArray(value.fallbackBindings) || value.fallbackBindings.length > 3)
      return undefined;
    const seen = new Set<string>([modelBinding.connectionId]);
    fallbackBindings = [];
    for (const item of value.fallbackBindings) {
      const binding = parseBinding(item, workspaceId);
      if (
        !binding ||
        binding.scope.kind !== modelBinding.scope.kind ||
        binding.scope.id !== modelBinding.scope.id ||
        seen.has(binding.connectionId)
      )
        return undefined;
      seen.add(binding.connectionId);
      fallbackBindings.push(binding);
    }
  }
  if (fallbackBindings?.length && !retryPolicy) return undefined;
  return {
    ...('avatarObjectId' in value
      ? {
          avatarObjectId:
            value.avatarObjectId === null ? null : String(value.avatarObjectId).toLowerCase(),
        }
      : {}),
    name: value.name,
    roleDescription: value.roleDescription,
    description: value.description,
    instructions: value.instructions,
    modelBinding,
    limits: {
      maxTotalTokens: value.limits.maxTotalTokens,
      maxDurationSeconds: value.limits.maxDurationSeconds,
      maxTurns: value.limits.maxTurns,
      maxDelegationDepth: value.limits.maxDelegationDepth,
    },
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(fallbackBindings === undefined ? {} : { fallbackBindings }),
  };
}
export function parseBot(
  value: unknown,
  workspaceId: string,
  detail: boolean,
): BotSummary | BotDetail | undefined {
  const baseKeys =
    'accessRole,bindingStatus,description,id,lifecycleState,name,roleDescription,visibility,workspaceId';
  const hasVersion =
    detail &&
    keys(
      value,
      'accessRole,bindingStatus,currentVersion,description,id,lifecycleState,name,roleDescription,visibility,workspaceId',
      ['avatarVersionId'],
    );
  if (
    (!keys(value, baseKeys, ['avatarVersionId']) && !hasVersion) ||
    ('avatarVersionId' in value &&
      (!isBotUuid(value.avatarVersionId) || value.accessRole === null)) ||
    !isBotLifecycleState(value.lifecycleState) ||
    !isBotUuid(value.id) ||
    !isBotUuid(value.workspaceId) ||
    value.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
    !bounded(value.name, 1, 100) ||
    !bounded(value.roleDescription, 1, 200) ||
    !bounded(value.description, 0, 2000) ||
    (value.visibility !== 'private' && value.visibility !== 'workspace') ||
    (value.accessRole !== null &&
      value.accessRole !== 'owner' &&
      value.accessRole !== 'editor' &&
      value.accessRole !== 'user') ||
    (value.visibility === 'private' && value.accessRole === null) ||
    (detail && (value.accessRole !== null) !== hasVersion)
  )
    return undefined;
  const status = bindingStatus(value.bindingStatus);
  if (!status) return undefined;
  const summary: BotSummary = {
    ...('avatarVersionId' in value
      ? { avatarVersionId: String(value.avatarVersionId).toLowerCase() }
      : {}),
    lifecycleState: value.lifecycleState,
    id: value.id.toLowerCase(),
    workspaceId: value.workspaceId.toLowerCase(),
    name: value.name,
    roleDescription: value.roleDescription,
    description: value.description,
    visibility: value.visibility,
    accessRole: value.accessRole,
    bindingStatus: status,
  };
  if (!hasVersion) return summary;
  const version = value.currentVersion;
  if (
    !keys(version, 'author,configuration,createdAt,id,number,rationale') ||
    !isBotUuid(version.id) ||
    !integer(version.number, 1, Number.MAX_SAFE_INTEGER) ||
    !keys(version.author, 'displayName,id') ||
    !isBotUuid(version.author.id) ||
    !bounded(version.author.displayName, 1, 200) ||
    typeof version.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(version.createdAt)) ||
    !bounded(version.rationale, 1, 2000)
  )
    return undefined;
  const config = parseBotConfiguration(version.configuration, summary.workspaceId);
  if (
    !config ||
    (config.avatarObjectId
      ? summary.avatarVersionId !== version.id.toLowerCase()
      : summary.avatarVersionId !== undefined) ||
    config.name !== summary.name ||
    config.roleDescription !== summary.roleDescription ||
    config.description !== summary.description
  )
    return undefined;
  return {
    ...summary,
    currentVersion: {
      id: version.id.toLowerCase(),
      number: version.number,
      author: { id: version.author.id.toLowerCase(), displayName: version.author.displayName },
      createdAt: version.createdAt,
      rationale: version.rationale,
      configuration: config,
    },
  };
}
export function isBotLifecycleState(value: unknown): value is BotLifecycleState {
  return value === 'active' || value === 'archived' || value === 'deleted';
}
export function isBotDetail(bot: BotSummary | BotDetail): bot is BotDetail {
  return 'currentVersion' in bot;
}
export class BotApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}
  async create(
    session: string | undefined,
    workspaceId: string,
    input: BotInput,
  ): Promise<BotResult<BotDetail>> {
    const result = await this.send(session, workspaceId, undefined, input);
    if (result.status !== 'available') return result;
    const bot = keys(result.value.payload, 'bot')
      ? parseBot(result.value.payload.bot, workspaceId, true)
      : undefined;
    return result.value.status === 201 &&
      bot &&
      isBotDetail(bot) &&
      bot.currentVersion.number === 1 &&
      bot.accessRole === 'owner' &&
      bot.visibility === 'private' &&
      bot.lifecycleState === 'active'
      ? { status: 'available', value: bot }
      : { status: 'unavailable' };
  }
  async list(
    session: string | undefined,
    workspaceId: string,
    view: BotListView = 'default',
  ): Promise<BotResult<BotSummary[]>> {
    if (view !== 'default' && view !== 'deleted' && view !== 'usable') return { status: 'invalid' };
    const result = await this.send(session, workspaceId, undefined, undefined, view);
    if (result.status !== 'available') return result;
    if (
      result.value.status !== 200 ||
      !keys(result.value.payload, 'bots') ||
      !Array.isArray(result.value.payload.bots)
    )
      return { status: 'unavailable' };
    const bots: BotSummary[] = [];
    const ids = new Set<string>();
    for (const value of result.value.payload.bots) {
      const bot = parseBot(value, workspaceId, false);
      if (
        !bot ||
        ids.has(bot.id) ||
        (view === 'deleted'
          ? bot.lifecycleState !== 'deleted' || bot.accessRole !== 'owner'
          : view === 'usable'
            ? bot.lifecycleState !== 'active' || bot.accessRole === null
            : bot.lifecycleState === 'deleted')
      )
        return { status: 'unavailable' };
      ids.add(bot.id);
      bots.push(bot);
    }
    return { status: 'available', value: bots };
  }
  async get(
    session: string | undefined,
    workspaceId: string,
    botId: string,
  ): Promise<BotResult<BotSummary | BotDetail>> {
    const result = await this.send(session, workspaceId, botId);
    if (result.status !== 'available') return result;
    const bot = keys(result.value.payload, 'bot')
      ? parseBot(result.value.payload.bot, workspaceId, true)
      : undefined;
    return result.value.status === 200 && bot && bot.id === botId.toLowerCase()
      ? { status: 'available', value: bot }
      : { status: 'unavailable' };
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    botId?: string,
    input?: BotInput,
    view: BotListView = 'default',
  ): Promise<BotResult<{ status: number; payload: unknown }>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (!isBotUuid(workspaceId) || (botId !== undefined && !isBotUuid(botId)))
      return { status: 'invalid' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.request(
        `${this.baseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/bots${botId === undefined ? '' : `/${botId.toLowerCase()}`}${view === 'default' ? '' : `?view=${view}`}`,
        {
          method: input === undefined ? 'GET' : 'POST',
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${session}`,
            origin: new URL(this.webOrigin).origin,
            ...(input === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
          signal: controller.signal,
        },
      );
      if (response.status === 401) return { status: 'anonymous' };
      const payload: unknown = await response.json();
      if (keys(payload, 'error')) {
        if (keys(payload.error, 'code')) {
          if (
            response.status === 403 &&
            (payload.error.code === 'bot_forbidden' || payload.error.code === 'invalid_origin')
          )
            return { status: 'forbidden' };
          if (response.status === 400 && payload.error.code === 'invalid_bot_request')
            return { status: 'invalid' };
        }
        if (
          response.status === 400 &&
          keys(payload.error, 'code,reason') &&
          payload.error.code === 'bot_model_unavailable' &&
          reason(payload.error.reason)
        )
          return { status: 'model-unavailable', reason: payload.error.reason };
      }
      return response.ok
        ? { status: 'available', value: { status: response.status, payload } }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
export function createBotApiClient(request: typeof fetch): BotApiClient {
  return new BotApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}

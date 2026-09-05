import { SESSION_COOKIE_NAME } from './auth-api.js';
import {
  isBotUuid,
  parseBotConfiguration,
  type BotDetail,
  type BindingUnavailableReason,
  type BotConfiguration,
  type BotLimits,
} from './bot-api.js';

export type BotVersion = BotDetail['currentVersion'];
export type BotVersionSummary = Omit<BotVersion, 'configuration'>;
export interface BotVersionPage {
  currentVersionId: string;
  versions: BotVersionSummary[];
  nextBefore: number | null;
}
export type BotVersionChanges = Partial<Omit<BotConfiguration, 'avatarObjectId' | 'limits'>> & {
  limits?: Partial<BotLimits>;
};
export interface BotVersionEdit {
  expectedCurrentVersionId: string;
  changes: BotVersionChanges;
  rationale?: string;
}
export interface BotVersionRestore {
  expectedCurrentVersionId: string;
  sourceVersionId: string;
  rationale?: string;
}
export const versionFields = [
  'name',
  'roleDescription',
  'description',
  'instructions',
  'modelBinding.scope.kind',
  'modelBinding.scope.id',
  'modelBinding.connectionId',
  'modelBinding.modelId',
  'avatarObjectId',
  'limits.maxTotalTokens',
  'limits.maxDurationSeconds',
  'limits.maxTurns',
  'limits.maxDelegationDepth',
] as const;
export type BotVersionField = (typeof versionFields)[number];
export interface BotVersionDifference {
  field: BotVersionField;
  before: string | number | null;
  after: string | number | null;
}
export interface BotVersionComparison {
  fromVersionId: string;
  toVersionId: string;
  differences: BotVersionDifference[];
}
export const versionLimitBounds = {
  maxTotalTokens: [1, 1000000],
  maxDurationSeconds: [1, 3600],
  maxTurns: [1, 100],
  maxDelegationDepth: [0, 8],
} as const;
export type BotVersionResult<T> =
  | { status: 'available'; value: T }
  | {
      status:
        | 'anonymous'
        | 'forbidden'
        | 'invalid'
        | 'not-found'
        | 'conflict'
        | 'avatar-unavailable'
        | 'unavailable';
    }
  | { status: 'model-unavailable'; reason: BindingUnavailableReason };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join(',') === expected;
}
function text(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}
function integer(value: unknown, min = 1, max = 2147483647): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function isField(value: unknown): value is BotVersionField {
  return typeof value === 'string' && versionFields.some((field) => field === value);
}
function fieldValue(field: BotVersionField, value: unknown): value is string | number | null {
  if (field === 'avatarObjectId') return value === null || isBotUuid(value);
  if (field === 'modelBinding.scope.id' || field === 'modelBinding.connectionId')
    return isBotUuid(value);
  if (field === 'modelBinding.scope.kind') return value === 'workspace' || value === 'personal';
  for (const [name, [min, max]] of Object.entries(versionLimitBounds))
    if (field === `limits.${name}`) return integer(value, min, max);
  if (field === 'name') return text(value, 1, 100);
  if (field === 'roleDescription') return text(value, 1, 200);
  if (field === 'description') return text(value, 0, 2000);
  if (field === 'instructions') return text(value, 1, 32000);
  return field === 'modelBinding.modelId' && text(value, 1, 256);
}
export function parseBotVersionChanges(
  value: unknown,
  workspaceId: string,
): BotVersionChanges | undefined {
  if (
    !object(value) ||
    Object.keys(value).some(
      (field) =>
        ![
          'name',
          'roleDescription',
          'description',
          'instructions',
          'modelBinding',
          'limits',
        ].includes(field),
    )
  )
    return undefined;
  const result: BotVersionChanges = {};
  for (const field of ['name', 'roleDescription', 'description', 'instructions'] as const) {
    if (!(field in value)) continue;
    const input = value[field];
    if (typeof input !== 'string' || !fieldValue(field, input)) return undefined;
    result[field] = field === 'instructions' ? input : input.trim();
  }
  if ('modelBinding' in value) {
    const binding = value.modelBinding;
    if (
      !keys(binding, 'connectionId,modelId,scope') ||
      !isBotUuid(binding.connectionId) ||
      !text(binding.modelId, 1, 256) ||
      !keys(binding.scope, 'id,kind') ||
      !isBotUuid(binding.scope.id) ||
      (binding.scope.kind !== 'personal' && binding.scope.kind !== 'workspace') ||
      (binding.scope.kind === 'workspace' &&
        binding.scope.id.toLowerCase() !== workspaceId.toLowerCase())
    )
      return undefined;
    result.modelBinding = {
      connectionId: binding.connectionId.toLowerCase(),
      modelId: binding.modelId,
      scope: { kind: binding.scope.kind, id: binding.scope.id.toLowerCase() },
    };
  }
  if ('limits' in value) {
    if (
      !object(value.limits) ||
      Object.keys(value.limits).some((field) => !Object.hasOwn(versionLimitBounds, field))
    )
      return undefined;
    const limits: Partial<BotLimits> = {};
    for (const field of [
      'maxTotalTokens',
      'maxDurationSeconds',
      'maxTurns',
      'maxDelegationDepth',
    ] as const) {
      if (!(field in value.limits)) continue;
      const input = value.limits[field];
      const [min, max] = versionLimitBounds[field];
      if (!integer(input, min, max)) return undefined;
      limits[field] = input;
    }
    result.limits = limits;
  }
  return result;
}
function expectedRequest(
  value: unknown,
  allowed: string[],
): value is { expectedCurrentVersionId: string; rationale?: string } & Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).every((field) => allowed.includes(field)) &&
    isBotUuid(value.expectedCurrentVersionId) &&
    (!('rationale' in value) ||
      (typeof value.rationale === 'string' && value.rationale.length <= 500))
  );
}
function summary(value: unknown): BotVersionSummary | undefined {
  if (
    !keys(value, 'author,createdAt,id,number,rationale') ||
    !isBotUuid(value.id) ||
    !integer(value.number) ||
    !keys(value.author, 'displayName,id') ||
    !isBotUuid(value.author.id) ||
    !text(value.author.displayName, 1, 200) ||
    !text(value.rationale, 1, 500) ||
    typeof value.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    return undefined;
  return {
    id: value.id.toLowerCase(),
    number: value.number,
    author: { id: value.author.id.toLowerCase(), displayName: value.author.displayName },
    createdAt: value.createdAt,
    rationale: value.rationale,
  };
}
function version(value: unknown, workspaceId: string): BotVersion | undefined {
  if (!keys(value, 'author,configuration,createdAt,id,number,rationale')) return undefined;
  const { configuration: input, ...metadata } = value;
  const info = summary(metadata);
  const configuration = parseBotConfiguration(input, workspaceId.toLowerCase());
  return info && configuration ? { ...info, configuration } : undefined;
}
async function readJson(response: Response, controller: AbortController): Promise<unknown> {
  const maximum = 1048576;
  const advertised = response.headers.get('content-length');
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum))
    throw new Error('Invalid response size');
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maximum) {
        controller.abort();
        throw new Error('Response too large');
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export class BotVersionApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
    private readonly requestSignal?: AbortSignal,
  ) {}
  async edit(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    input: BotVersionEdit,
  ): Promise<BotVersionResult<BotVersion>> {
    if (!expectedRequest(input, ['expectedCurrentVersionId', 'changes', 'rationale']))
      return { status: 'invalid' };
    const changes = parseBotVersionChanges(input.changes, workspaceId);
    if (!changes) return { status: 'invalid' };
    const result = await this.send(session, workspaceId, botId, '/configuration', 'PATCH', {
      expectedCurrentVersionId: input.expectedCurrentVersionId.toLowerCase(),
      changes,
      ...(input.rationale?.trim() ? { rationale: input.rationale.trim() } : {}),
    });
    if (result.status !== 'available') return result;
    const parsed = keys(result.value, 'version')
      ? version(result.value.version, workspaceId)
      : undefined;
    if (!parsed) return { status: 'unavailable' };
    for (const field of ['name', 'roleDescription', 'description', 'instructions'] as const)
      if (field in changes && changes[field] !== parsed.configuration[field])
        return { status: 'unavailable' };
    if (
      changes.modelBinding &&
      JSON.stringify(changes.modelBinding) !==
        JSON.stringify({
          connectionId: parsed.configuration.modelBinding.connectionId,
          modelId: parsed.configuration.modelBinding.modelId,
          scope: parsed.configuration.modelBinding.scope,
        })
    )
      return { status: 'unavailable' };
    for (const field of [
      'maxTotalTokens',
      'maxDurationSeconds',
      'maxTurns',
      'maxDelegationDepth',
    ] as const)
      if (
        changes.limits &&
        field in changes.limits &&
        changes.limits[field] !== parsed.configuration.limits[field]
      )
        return { status: 'unavailable' };
    return { status: 'available', value: parsed };
  }
  async restore(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    input: BotVersionRestore,
  ): Promise<BotVersionResult<BotVersion>> {
    if (
      !expectedRequest(input, ['expectedCurrentVersionId', 'sourceVersionId', 'rationale']) ||
      !isBotUuid(input.sourceVersionId)
    )
      return { status: 'invalid' };
    const result = await this.send(session, workspaceId, botId, '/versions/restore', 'POST', {
      expectedCurrentVersionId: input.expectedCurrentVersionId.toLowerCase(),
      sourceVersionId: input.sourceVersionId.toLowerCase(),
      ...(input.rationale?.trim() ? { rationale: input.rationale.trim() } : {}),
    });
    if (result.status !== 'available') return result;
    const parsed = keys(result.value, 'version')
      ? version(result.value.version, workspaceId)
      : undefined;
    return parsed &&
      parsed.number > 1 &&
      parsed.id !== input.sourceVersionId.toLowerCase() &&
      parsed.id !== input.expectedCurrentVersionId.toLowerCase()
      ? { status: 'available', value: parsed }
      : { status: 'unavailable' };
  }
  async compare(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    from: string,
    to: string,
  ): Promise<BotVersionResult<BotVersionComparison>> {
    if (!isBotUuid(from) || !isBotUuid(to)) return { status: 'invalid' };
    const query = new URLSearchParams({
      fromVersionId: from.toLowerCase(),
      toVersionId: to.toLowerCase(),
    });
    const result = await this.send(session, workspaceId, botId, `/versions/compare?${query}`);
    if (result.status !== 'available') return result;
    const payload = result.value;
    if (
      !keys(payload, 'differences,fromVersionId,toVersionId') ||
      !isBotUuid(payload.fromVersionId) ||
      !isBotUuid(payload.toVersionId) ||
      payload.fromVersionId.toLowerCase() !== from.toLowerCase() ||
      payload.toVersionId.toLowerCase() !== to.toLowerCase() ||
      !Array.isArray(payload.differences) ||
      payload.differences.length > versionFields.length
    )
      return { status: 'unavailable' };
    const differences: BotVersionDifference[] = [];
    let previous = -1;
    for (const item of payload.differences) {
      if (
        !keys(item, 'after,before,field') ||
        !isField(item.field) ||
        versionFields.indexOf(item.field) <= previous ||
        !fieldValue(item.field, item.before) ||
        !fieldValue(item.field, item.after) ||
        item.before === item.after
      )
        return { status: 'unavailable' };
      previous = versionFields.indexOf(item.field);
      differences.push({ field: item.field, before: item.before, after: item.after });
    }
    if (from.toLowerCase() === to.toLowerCase() && differences.length)
      return { status: 'unavailable' };
    return {
      status: 'available',
      value: { fromVersionId: from.toLowerCase(), toVersionId: to.toLowerCase(), differences },
    };
  }
  async get(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    versionId: string,
  ): Promise<BotVersionResult<BotVersion>> {
    if (!isBotUuid(versionId)) return { status: 'invalid' };
    const result = await this.send(
      session,
      workspaceId,
      botId,
      `/versions/${versionId.toLowerCase()}`,
    );
    if (result.status !== 'available') return result;
    const parsed = keys(result.value, 'version')
      ? version(result.value.version, workspaceId)
      : undefined;
    return parsed?.id === versionId.toLowerCase()
      ? { status: 'available', value: parsed }
      : { status: 'unavailable' };
  }
  async list(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    query: { before?: number; limit?: number } = {},
  ): Promise<BotVersionResult<BotVersionPage>> {
    if (
      Object.keys(query).some((key) => !['before', 'limit'].includes(key)) ||
      (query.before !== undefined && !integer(query.before)) ||
      (query.limit !== undefined && !integer(query.limit, 1, 100))
    )
      return { status: 'invalid' };
    const params = new URLSearchParams();
    if (query.before !== undefined) params.set('before', String(query.before));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const result = await this.send(
      session,
      workspaceId,
      botId,
      `/versions${params.size ? `?${params}` : ''}`,
    );
    if (result.status !== 'available') return result;
    const page = result.value;
    if (
      !keys(page, 'currentVersionId,nextBefore,versions') ||
      !isBotUuid(page.currentVersionId) ||
      !Array.isArray(page.versions) ||
      page.versions.length > (query.limit ?? 50) ||
      (page.nextBefore !== null && !integer(page.nextBefore, 2))
    )
      return { status: 'unavailable' };
    const versions: BotVersionSummary[] = [];
    const ids = new Set<string>();
    for (const input of page.versions) {
      const parsed = summary(input);
      if (
        !parsed ||
        ids.has(parsed.id) ||
        parsed.number >= (versions.at(-1)?.number ?? query.before ?? 2147483647)
      )
        return { status: 'unavailable' };
      versions.push(parsed);
      ids.add(parsed.id);
    }
    if (
      page.nextBefore !== null &&
      (versions.length !== (query.limit ?? 50) || page.nextBefore !== versions.at(-1)?.number)
    )
      return { status: 'unavailable' };
    return {
      status: 'available',
      value: {
        currentVersionId: page.currentVersionId.toLowerCase(),
        versions,
        nextBefore: page.nextBefore,
      },
    };
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<BotVersionResult<unknown>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (!isBotUuid(workspaceId) || !isBotUuid(botId)) return { status: 'invalid' };
    const controller = new AbortController();
    const signal = this.requestSignal
      ? AbortSignal.any([controller.signal, this.requestSignal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      signal.throwIfAborted();
      const response = await this.request(
        `${this.baseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/bots/${botId.toLowerCase()}${path}`,
        {
          method,
          redirect: 'error',
          signal,
          headers: {
            origin: new URL(this.webOrigin).origin,
            cookie: `${SESSION_COOKIE_NAME}=${session}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (response.status === 401) return { status: 'anonymous' };
      const payload = await readJson(response, controller);
      if (
        response.status === 400 &&
        keys(payload, 'error') &&
        keys(payload.error, 'code,reason') &&
        payload.error.code === 'bot_model_unavailable'
      ) {
        const reason = payload.error.reason;
        if (
          reason === 'disabled' ||
          reason === 'binding-changed' ||
          reason === 'capability-unavailable' ||
          reason === 'not-accessible'
        )
          return { status: 'model-unavailable', reason };
      }
      if (keys(payload, 'error') && keys(payload.error, 'code')) {
        const code = payload.error.code;
        if (response.status === 403 && (code === 'invalid_origin' || code === 'bot_forbidden'))
          return { status: 'forbidden' };
        if ([400, 413, 415].includes(response.status) && code === 'invalid_bot_version_request')
          return { status: 'invalid' };
        if (response.status === 404 && code === 'bot_version_not_found')
          return { status: 'not-found' };
        if (response.status === 409 && code === 'bot_version_conflict')
          return { status: 'conflict' };
        if (response.status === 409 && code === 'bot_avatar_unavailable')
          return { status: 'avatar-unavailable' };
      }
      return response.status === 200
        ? { status: 'available', value: payload }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }
}
export function createBotVersionApiClient(request: typeof fetch, signal?: AbortSignal) {
  return new BotVersionApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    signal,
  );
}

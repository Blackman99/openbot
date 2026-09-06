import { SESSION_COOKIE_NAME } from './auth-api.js';
import { isBotDetail, parseBot, type BotDetail } from './bot-api.js';

export const BOT_TEMPLATE_SCHEMA_VERSION = 'openbot.bot-template.v1';

const FORBIDDEN_FIELDS = new Set([
  'apikey',
  'attachment',
  'attachmentbody',
  'attachmentid',
  'avatarobjectid',
  'backendid',
  'connectionid',
  'connectionrevision',
  'conversation',
  'conversationhistory',
  'conversationid',
  'credential',
  'filecontents',
  'headers',
  'history',
  'memory',
  'memoryid',
  'objectid',
  'objectreference',
  'password',
  'privatememory',
  'privatememoryid',
  'sealedcredentials',
  'secret',
  'sourcebotid',
  'sourceworkspaceid',
  'storageid',
  'storedobject',
  'token',
]);

export interface BotTemplate {
  schemaVersion: typeof BOT_TEMPLATE_SCHEMA_VERSION;
  identity: { name: string; roleDescription: string; description: string };
  instructions: string;
  capabilities: { required: 'basic' | 'collaboration' | 'visionInput' };
  collaboration: { visibility: 'private' | 'workspace' };
  budgets: {
    maxTotalTokens: number;
    maxDurationSeconds: number;
    maxTurns: number;
    maxDelegationDepth: number;
  };
  retryPolicy?: { maxAttemptsPerModel: number; maxRunsPerChain: number };
}

export interface BotTemplateDifference {
  field: string;
  template: unknown;
  local: unknown;
}

export interface BotTemplatePreview {
  template: BotTemplate;
  differences: BotTemplateDifference[];
}

export type BotTemplateResult<T> =
  | { status: 'available'; value: T }
  | { status: 'anonymous' }
  | { status: 'forbidden' }
  | { status: 'invalid'; fields?: Array<{ field: string; code: string }> }
  | { status: 'unavailable' };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function forbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbidden);
  if (!object(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) => FORBIDDEN_FIELDS.has(key.toLowerCase()) || forbidden(nested),
  );
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function keys(
  value: unknown,
  expected: string,
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value)
      .filter((key) => !optional.includes(key))
      .sort()
      .join(',') === expected
  );
}

export function parseBotTemplate(value: unknown): BotTemplate | undefined {
  if (forbidden(value)) return undefined;
  if (
    !keys(value, 'budgets,capabilities,collaboration,identity,instructions,schemaVersion', [
      'retryPolicy',
    ]) ||
    value.schemaVersion !== BOT_TEMPLATE_SCHEMA_VERSION ||
    !keys(value.identity, 'description,name,roleDescription') ||
    typeof value.identity.name !== 'string' ||
    !value.identity.name.trim() ||
    value.identity.name.trim().length > 100 ||
    typeof value.identity.roleDescription !== 'string' ||
    !value.identity.roleDescription.trim() ||
    value.identity.roleDescription.trim().length > 200 ||
    typeof value.identity.description !== 'string' ||
    value.identity.description.length > 2000 ||
    typeof value.instructions !== 'string' ||
    !value.instructions.trim() ||
    value.instructions.length > 32000 ||
    !keys(value.capabilities, 'required') ||
    (value.capabilities.required !== 'basic' &&
      value.capabilities.required !== 'collaboration' &&
      value.capabilities.required !== 'visionInput') ||
    !keys(value.collaboration, 'visibility') ||
    (value.collaboration.visibility !== 'private' &&
      value.collaboration.visibility !== 'workspace') ||
    !keys(value.budgets, 'maxDelegationDepth,maxDurationSeconds,maxTotalTokens,maxTurns') ||
    !integer(value.budgets.maxTotalTokens, 1, 1_000_000) ||
    !integer(value.budgets.maxDurationSeconds, 1, 3600) ||
    !integer(value.budgets.maxTurns, 1, 100) ||
    !integer(value.budgets.maxDelegationDepth, 0, 8)
  )
    return undefined;
  let retryPolicy: BotTemplate['retryPolicy'];
  if (value.retryPolicy !== undefined) {
    const retry = value.retryPolicy;
    if (
      !keys(retry, 'maxAttemptsPerModel,maxRunsPerChain') ||
      !integer(retry.maxAttemptsPerModel, 1, 3) ||
      !integer(retry.maxRunsPerChain, 1, 4)
    )
      return undefined;
    retryPolicy = {
      maxAttemptsPerModel: retry.maxAttemptsPerModel,
      maxRunsPerChain: retry.maxRunsPerChain,
    };
  }
  return {
    schemaVersion: BOT_TEMPLATE_SCHEMA_VERSION,
    identity: {
      name: value.identity.name.trim(),
      roleDescription: value.identity.roleDescription.trim(),
      description: value.identity.description.trim(),
    },
    instructions: value.instructions,
    capabilities: { required: value.capabilities.required },
    collaboration: { visibility: value.collaboration.visibility },
    budgets: {
      maxTotalTokens: value.budgets.maxTotalTokens,
      maxDurationSeconds: value.budgets.maxDurationSeconds,
      maxTurns: value.budgets.maxTurns,
      maxDelegationDepth: value.budgets.maxDelegationDepth,
    },
    ...(retryPolicy ? { retryPolicy } : {}),
  };
}

export function parseBotTemplatePreview(value: unknown): BotTemplatePreview | undefined {
  if (
    !keys(value, 'differences,template') ||
    !Array.isArray(value.differences) ||
    value.differences.some(
      (row) => !keys(row, 'field,local,template') || typeof row.field !== 'string' || !row.field,
    )
  )
    return undefined;
  const template = parseBotTemplate(value.template);
  if (!template) return undefined;
  return {
    template,
    differences: value.differences.map((row) => {
      const item = row as BotTemplateDifference;
      return { field: item.field, template: item.template, local: item.local };
    }),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function result<T>(
  status: number,
  body: unknown,
  read: (value: unknown) => T | undefined,
): BotTemplateResult<T> {
  if (status === 401) return { status: 'anonymous' };
  if (status === 403) return { status: 'forbidden' };
  if (status === 400) {
    const error =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { fields?: Array<{ field: string; code: string }> } }).error
        : undefined;
    return { status: 'invalid', ...(error?.fields ? { fields: error.fields } : {}) };
  }
  if (status >= 200 && status < 300) {
    const value = read(body);
    if (value !== undefined) return { status: 'available', value };
  }
  return { status: 'unavailable' };
}

export class BotTemplateApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/u, '')}/api/v1${path}`;
  }

  private headers(session: string, body?: unknown): HeadersInit {
    return {
      cookie: `${SESSION_COOKIE_NAME}=${session}`,
      origin: new URL(this.webOrigin).origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
  }

  async export(
    session: string,
    workspaceId: string,
    botId: string,
  ): Promise<BotTemplateResult<BotTemplate>> {
    const response = await this.request(
      this.url(`/workspaces/${workspaceId}/bots/${botId}/template`),
      { headers: this.headers(session) },
    );
    const body = await readJson(response);
    return result(response.status, body, (value) => {
      if (!value || typeof value !== 'object' || !('template' in value)) return undefined;
      return parseBotTemplate((value as { template: unknown }).template);
    });
  }

  async preview(
    session: string,
    workspaceId: string,
    payload: { template: unknown; compareBotId?: string },
  ): Promise<BotTemplateResult<BotTemplatePreview>> {
    const response = await this.request(
      this.url(`/workspaces/${workspaceId}/bot-templates/previews`),
      {
        method: 'POST',
        headers: this.headers(session, payload),
        body: JSON.stringify(payload),
      },
    );
    const body = await readJson(response);
    return result(response.status, body, (value) => {
      if (!value || typeof value !== 'object' || !('preview' in value)) return undefined;
      return parseBotTemplatePreview((value as { preview: unknown }).preview);
    });
  }

  async import(
    session: string,
    workspaceId: string,
    payload: { template: unknown; modelBinding: unknown },
  ): Promise<BotTemplateResult<BotDetail>> {
    if (!parseBotTemplate(payload.template)) return { status: 'invalid' };
    const response = await this.request(this.url(`/workspaces/${workspaceId}/bot-templates`), {
      method: 'POST',
      headers: this.headers(session, payload),
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    return result(response.status, body, (value) => {
      const bot =
        value && typeof value === 'object' && 'bot' in value
          ? parseBot((value as { bot: unknown }).bot, workspaceId, true)
          : undefined;
      return bot && isBotDetail(bot) && bot.visibility === 'private' && bot.accessRole === 'owner'
        ? bot
        : undefined;
    });
  }
}

export function createBotTemplateApiClient(fetchFn: typeof fetch) {
  return new BotTemplateApiClient(
    fetchFn,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}

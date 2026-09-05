import { SESSION_COOKIE_NAME } from './auth-api.js';
import {
  bindingStatus,
  isBotDetail,
  isBotUuid,
  parseBot,
  parseBotConfiguration,
  type BindingStatus,
  type BotConfiguration,
  type BotDetail,
} from './bot-api.js';
import { parseBotVersionChanges, type BotVersionResult } from './bot-version-api.js';
export const copyIncluded = [
  'identity',
  'instructions',
  'executionLimits',
  'avatarReference',
  'modelBinding',
] as const;
export const copyExcluded = [
  'credentials',
  'acls',
  'history',
  'memory',
  'fileContents',
  'audits',
] as const;
export interface BotCopyPreview {
  sourceBotId: string;
  sourceVersionId: string;
  sourceVersionNumber: number;
  configuration: BotConfiguration;
  bindingStatus: BindingStatus;
  included: typeof copyIncluded;
  excluded: typeof copyExcluded;
}
export interface BotCopyRequest {
  expectedCurrentVersionId: string;
  modelBinding?: BotConfiguration['modelBinding'];
}
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maximum = 262144;
  const advertised = response.headers.get('content-length');
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum))
    throw new Error('Invalid response size');
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maximum) throw new Error('Response too large');
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
export class BotCopyApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
    private readonly requestSignal?: AbortSignal,
  ) {}
  async preview(
    session: string | undefined,
    workspaceId: string,
    botId: string,
  ): Promise<BotVersionResult<BotCopyPreview>> {
    const result = await this.send(session, workspaceId, botId, '/copy-preview');
    if (result.status !== 'available') return result;
    const value = keys(result.value, 'preview') ? result.value.preview : undefined;
    if (
      !keys(
        value,
        'bindingStatus,configuration,excluded,included,sourceBotId,sourceVersionId,sourceVersionNumber',
      ) ||
      !isBotUuid(value.sourceBotId) ||
      value.sourceBotId.toLowerCase() !== botId.toLowerCase() ||
      !isBotUuid(value.sourceVersionId) ||
      !Number.isSafeInteger(value.sourceVersionNumber) ||
      Number(value.sourceVersionNumber) < 1 ||
      JSON.stringify(value.included) !== JSON.stringify(copyIncluded) ||
      JSON.stringify(value.excluded) !== JSON.stringify(copyExcluded)
    )
      return { status: 'unavailable' };
    const configuration = parseBotConfiguration(value.configuration, workspaceId.toLowerCase()),
      status = bindingStatus(value.bindingStatus);
    return configuration && status
      ? {
          status: 'available',
          value: {
            sourceBotId: value.sourceBotId.toLowerCase(),
            sourceVersionId: value.sourceVersionId.toLowerCase(),
            sourceVersionNumber: Number(value.sourceVersionNumber),
            configuration,
            bindingStatus: status,
            included: copyIncluded,
            excluded: copyExcluded,
          },
        }
      : { status: 'unavailable' };
  }
  async confirm(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    input: BotCopyRequest,
  ): Promise<BotVersionResult<BotDetail>> {
    if (
      (!keys(input, 'expectedCurrentVersionId') &&
        !keys(input, 'expectedCurrentVersionId,modelBinding')) ||
      !isBotUuid(input.expectedCurrentVersionId)
    )
      return { status: 'invalid' };
    const changes =
      'modelBinding' in input
        ? parseBotVersionChanges({ modelBinding: input.modelBinding }, workspaceId)
        : {};
    if (!changes) return { status: 'invalid' };
    const result = await this.send(session, workspaceId, botId, '/copy', {
      expectedCurrentVersionId: input.expectedCurrentVersionId.toLowerCase(),
      ...changes,
    });
    if (result.status !== 'available') return result;
    const bot = keys(result.value, 'bot')
      ? parseBot(result.value.bot, workspaceId, true)
      : undefined;
    if (
      !bot ||
      !isBotDetail(bot) ||
      bot.id === botId.toLowerCase() ||
      bot.visibility !== 'private' ||
      bot.lifecycleState !== 'active' ||
      bot.accessRole !== 'owner' ||
      bot.currentVersion.id === input.expectedCurrentVersionId.toLowerCase() ||
      bot.currentVersion.number !== 1 ||
      bot.currentVersion.rationale !== 'Copied configuration' ||
      bot.bindingStatus.state !== 'ready' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(bot.currentVersion.createdAt) ||
      new Date(bot.currentVersion.createdAt).toISOString() !== bot.currentVersion.createdAt
    )
      return { status: 'unavailable' };
    if (
      changes.modelBinding &&
      JSON.stringify(changes.modelBinding) !==
        JSON.stringify({
          connectionId: bot.currentVersion.configuration.modelBinding.connectionId,
          modelId: bot.currentVersion.configuration.modelBinding.modelId,
          scope: bot.currentVersion.configuration.modelBinding.scope,
        })
    )
      return { status: 'unavailable' };
    return { status: 'available', value: bot };
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    path: string,
    body?: unknown,
  ): Promise<BotVersionResult<unknown>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (!isBotUuid(workspaceId) || !isBotUuid(botId)) return { status: 'invalid' };
    const controller = new AbortController(),
      signal = this.requestSignal
        ? AbortSignal.any([controller.signal, this.requestSignal])
        : controller.signal;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      signal.throwIfAborted();
      const response = await this.request(
        `${this.baseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/bots/${botId.toLowerCase()}${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
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
      const payload = await readJson(response, signal);
      if (
        response.status === 400 &&
        keys(payload, 'error') &&
        keys(payload.error, 'code,reason') &&
        payload.error.code === 'bot_model_unavailable'
      ) {
        const status = bindingStatus({ state: 'unavailable', reason: payload.error.reason });
        if (status?.state === 'unavailable')
          return { status: 'model-unavailable', reason: status.reason };
      }
      if (keys(payload, 'error') && keys(payload.error, 'code')) {
        const code = payload.error.code;
        if (response.status === 403 && ['invalid_origin', 'bot_forbidden'].includes(String(code)))
          return { status: 'forbidden' };
        if ([400, 413, 415].includes(response.status) && code === 'invalid_bot_copy_request')
          return { status: 'invalid' };
        if (response.status === 409 && code === 'bot_version_conflict')
          return { status: 'conflict' };
        if (response.status === 409 && code === 'bot_avatar_unavailable')
          return { status: 'avatar-unavailable' };
      }
      return response.status === (body === undefined ? 200 : 201)
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
export function createBotCopyApiClient(request: typeof fetch, signal?: AbortSignal) {
  return new BotCopyApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    signal,
  );
}

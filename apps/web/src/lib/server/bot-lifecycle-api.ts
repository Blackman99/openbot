import { SESSION_COOKIE_NAME } from './auth-api.js';
import {
  isBotUuid,
  isBotLifecycleState,
  type BotLifecycleState,
  type BindingUnavailableReason,
} from './bot-api.js';
export type BotLifecycleAction = 'archive' | 'restore' | 'delete' | 'undo-delete';
export interface BotLifecycle {
  botId: string;
  workspaceId: string;
  state: BotLifecycleState;
  deletedAt: string | null;
  recoveryDeadline: string | null;
  preDeletedState: 'active' | 'archived' | null;
}
export type BotLifecycleResult =
  | { status: 'available'; value: BotLifecycle }
  | { status: 'anonymous' | 'forbidden' | 'invalid' | 'conflict' | 'expired' | 'unavailable' }
  | { status: 'model-unavailable'; reason: BindingUnavailableReason };
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function parse(value: unknown, workspaceId: string, botId: string): BotLifecycle | undefined {
  if (
    !keys(value, 'botId,deletedAt,preDeletedState,recoveryDeadline,state,workspaceId') ||
    !isBotUuid(value.botId) ||
    value.botId.toLowerCase() !== botId.toLowerCase() ||
    !isBotUuid(value.workspaceId) ||
    value.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
    !isBotLifecycleState(value.state)
  )
    return undefined;
  if (value.state === 'deleted') {
    if (
      !timestamp(value.deletedAt) ||
      !timestamp(value.recoveryDeadline) ||
      Date.parse(value.recoveryDeadline) <= Date.parse(value.deletedAt) ||
      (value.preDeletedState !== 'active' && value.preDeletedState !== 'archived')
    )
      return undefined;
    return {
      botId: botId.toLowerCase(),
      workspaceId: workspaceId.toLowerCase(),
      state: value.state,
      deletedAt: value.deletedAt,
      recoveryDeadline: value.recoveryDeadline,
      preDeletedState: value.preDeletedState,
    };
  }
  if (value.deletedAt !== null || value.recoveryDeadline !== null || value.preDeletedState !== null)
    return undefined;
  return {
    botId: botId.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    state: value.state,
    deletedAt: null,
    recoveryDeadline: null,
    preDeletedState: null,
  };
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const advertised = response.headers.get('content-length');
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > 16384))
    throw new Error('Invalid size');
  if (!response.body) throw new Error('Empty body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.length;
      if (length > 16384) throw new Error('Oversized body');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}
export class BotLifecycleApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
    private readonly requestSignal?: AbortSignal,
  ) {}
  get(session: string | undefined, workspaceId: string, botId: string) {
    return this.send(session, workspaceId, botId);
  }
  change(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    action: BotLifecycleAction,
  ) {
    return this.send(session, workspaceId, botId, action);
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    action?: BotLifecycleAction,
  ): Promise<BotLifecycleResult> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (
      !isBotUuid(workspaceId) ||
      !isBotUuid(botId) ||
      (action !== undefined && !['archive', 'restore', 'delete', 'undo-delete'].includes(action))
    )
      return { status: 'invalid' };
    const controller = new AbortController();
    const signal = this.requestSignal
      ? AbortSignal.any([controller.signal, this.requestSignal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      signal.throwIfAborted();
      const response = await this.request(
        `${this.baseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/bots/${botId.toLowerCase()}/${action ?? 'lifecycle'}`,
        {
          method: action ? 'POST' : 'GET',
          redirect: 'error',
          signal,
          headers: {
            origin: new URL(this.webOrigin).origin,
            cookie: `${SESSION_COOKIE_NAME}=${session}`,
          },
        },
      );
      if (response.status === 401) return { status: 'anonymous' };
      const payload = await boundedJson(response, signal);
      if (keys(payload, 'error')) {
        if (keys(payload.error, 'code')) {
          const code = payload.error.code;
          if (response.status === 403 && (code === 'bot_forbidden' || code === 'invalid_origin'))
            return { status: 'forbidden' };
          if ([400, 413, 415].includes(response.status) && code === 'invalid_bot_request')
            return { status: 'invalid' };
          if (response.status === 409 && code === 'bot_lifecycle_conflict')
            return { status: 'conflict' };
          if (response.status === 409 && code === 'bot_recovery_expired')
            return { status: 'expired' };
        }
        if (
          response.status === 400 &&
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
      }
      const value = keys(payload, 'lifecycle')
        ? parse(payload.lifecycle, workspaceId, botId)
        : undefined;
      if (
        response.status !== 200 ||
        !value ||
        (action === 'archive' && value.state !== 'archived') ||
        (action === 'restore' && value.state !== 'active') ||
        (action === 'delete' && value.state !== 'deleted') ||
        (action === 'undo-delete' && value.state === 'deleted')
      )
        return { status: 'unavailable' };
      return { status: 'available', value };
    } catch {
      return { status: 'unavailable' };
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }
}
export function createBotLifecycleApiClient(request: typeof fetch, signal?: AbortSignal) {
  return new BotLifecycleApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    signal,
  );
}

import { SESSION_COOKIE_NAME } from './auth-api.js';
import { isBotLifecycleState, type BotLifecycleState, isBotUuid } from './bot-api.js';
import { isCommandKey, isConversationCursor, type MessageProjection } from './conversation-api.js';

export type HistoryChoice =
  | { mode: 'future-only' }
  | { mode: 'all' }
  | { mode: 'since-event'; eventId: string }
  | { mode: 'since-time'; time: string };
export type GrantHistory = HistoryChoice & { lowerBound: number };
export interface GroupBotGrant {
  id: string;
  groupId: string;
  conversationId: string;
  bot: {
    lifecycleState: BotLifecycleState;
    id: string;
    name: string;
    roleDescription: string;
    description: string;
    canInspect: boolean;
  };
  grantedBy: { id: string; displayName: string };
  history: GrantHistory;
  joined: { eventId: string; sequence: number; at: string };
  closed: null | {
    eventId: string;
    sequence: number;
    at: string;
    reason: 'removed' | 'bot-access-revoked' | 'workspace-access-removed';
  };
}
export interface GroupBotMembership {
  groupId: string;
  grants: GroupBotGrant[];
  activeCount: number;
  maxActive: 8;
  canManage: boolean;
}
export interface GroupBotContext {
  grantId: string;
  conversationId: string;
  messages: MessageProjection[];
  nextCursor: string | null;
}
export type GroupBotResult<T> =
  | { status: 'available'; value: T }
  | {
      status:
        | 'anonymous'
        | 'forbidden'
        | 'invalid'
        | 'idempotency-conflict'
        | 'already-active'
        | 'limit'
        | 'inactive'
        | 'unavailable';
    };
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
function integer(value: unknown, min = 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || Boolean(value.trim())) && value.length <= max;
}
function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function parseHistoryChoice(value: unknown): HistoryChoice | undefined {
  if (keys(value, 'mode') && (value.mode === 'future-only' || value.mode === 'all'))
    return { mode: value.mode };
  if (keys(value, 'eventId,mode') && value.mode === 'since-event' && isBotUuid(value.eventId))
    return { mode: value.mode, eventId: value.eventId.toLowerCase() };
  if (keys(value, 'mode,time') && value.mode === 'since-time' && date(value.time))
    return { mode: value.mode, time: value.time };
  return undefined;
}
function parseGrant(value: unknown, groupId: string): GroupBotGrant | undefined {
  if (
    !keys(value, 'bot,closed,conversationId,grantedBy,groupId,history,id,joined') ||
    !isBotUuid(value.id) ||
    !isBotUuid(value.groupId) ||
    value.groupId.toLowerCase() !== groupId.toLowerCase() ||
    !isBotUuid(value.conversationId) ||
    !keys(value.bot, 'canInspect,description,id,lifecycleState,name,roleDescription') ||
    !isBotLifecycleState(value.bot.lifecycleState) ||
    !isBotUuid(value.bot.id) ||
    !text(value.bot.name, 100) ||
    !text(value.bot.roleDescription, 200) ||
    !text(value.bot.description, 2000, true) ||
    typeof value.bot.canInspect !== 'boolean' ||
    !keys(value.grantedBy, 'displayName,id') ||
    !isBotUuid(value.grantedBy.id) ||
    !text(value.grantedBy.displayName, 200) ||
    !keys(value.joined, 'at,eventId,sequence') ||
    !isBotUuid(value.joined.eventId) ||
    !integer(value.joined.sequence) ||
    !date(value.joined.at) ||
    value.history === null ||
    typeof value.history !== 'object' ||
    Array.isArray(value.history) ||
    !('lowerBound' in value.history) ||
    !integer(value.history.lowerBound)
  )
    return undefined;
  const { lowerBound, ...choice } = value.history;
  const history = parseHistoryChoice(choice);
  if (
    !history ||
    lowerBound > value.joined.sequence ||
    (history.mode === 'future-only' && lowerBound !== value.joined.sequence) ||
    (history.mode === 'all' && lowerBound !== 1)
  )
    return undefined;
  let closed: GroupBotGrant['closed'] = null;
  if (value.closed !== null) {
    const c = value.closed;
    if (
      !keys(c, 'at,eventId,reason,sequence') ||
      !isBotUuid(c.eventId) ||
      !integer(c.sequence) ||
      c.sequence <= value.joined.sequence ||
      !date(c.at) ||
      (c.reason !== 'removed' &&
        c.reason !== 'bot-access-revoked' &&
        c.reason !== 'workspace-access-removed')
    )
      return undefined;
    closed = { eventId: c.eventId.toLowerCase(), sequence: c.sequence, at: c.at, reason: c.reason };
  }
  return {
    id: value.id.toLowerCase(),
    groupId: value.groupId.toLowerCase(),
    conversationId: value.conversationId.toLowerCase(),
    bot: {
      lifecycleState: value.bot.lifecycleState,
      id: value.bot.id.toLowerCase(),
      name: value.bot.name,
      roleDescription: value.bot.roleDescription,
      description: value.bot.description,
      canInspect: value.bot.canInspect,
    },
    grantedBy: { id: value.grantedBy.id.toLowerCase(), displayName: value.grantedBy.displayName },
    history: { ...history, lowerBound },
    joined: {
      eventId: value.joined.eventId.toLowerCase(),
      sequence: value.joined.sequence,
      at: value.joined.at,
    },
    closed,
  };
}
function projection(value: unknown): MessageProjection | undefined {
  if (
    !keys(
      value,
      'author,body,canAudit,canDelete,canEdit,createdAt,creationSequence,deleted,id,reason,sequence,updatedAt,version,versionEventId',
    ) ||
    !isBotUuid(value.id) ||
    !isBotUuid(value.versionEventId) ||
    !integer(value.creationSequence) ||
    !integer(value.sequence) ||
    value.sequence < value.creationSequence ||
    !integer(value.version) ||
    !keys(value.author, 'displayName,id') ||
    !isBotUuid(value.author.id) ||
    !text(value.author.displayName, 200) ||
    typeof value.deleted !== 'boolean' ||
    !date(value.createdAt) ||
    !date(value.updatedAt) ||
    value.canEdit !== false ||
    value.canDelete !== false ||
    value.canAudit !== false ||
    (value.deleted
      ? value.body !== null || !text(value.reason, 500)
      : !text(value.body, 32000) || value.reason !== null)
  )
    return undefined;
  return {
    id: value.id.toLowerCase(),
    versionEventId: value.versionEventId.toLowerCase(),
    creationSequence: value.creationSequence,
    sequence: value.sequence,
    version: value.version,
    author: { id: value.author.id.toLowerCase(), displayName: value.author.displayName },
    body: typeof value.body === 'string' ? value.body : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    deleted: value.deleted,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    canEdit: false,
    canDelete: false,
    canAudit: false,
  };
}
async function readJson(response: Response, controller: AbortController): Promise<unknown> {
  const maximum = response.status === 200 ? 33554432 : 1048576;
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
export class GroupBotApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
    private readonly requestSignal?: AbortSignal,
  ) {}
  async list(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupBotResult<GroupBotMembership>> {
    const result = await this.send(session, workspaceId, groupId);
    if (result.status !== 'available') return result;
    const p = result.value;
    if (
      !keys(p, 'activeCount,canManage,grants,groupId,maxActive') ||
      !isBotUuid(p.groupId) ||
      p.groupId.toLowerCase() !== groupId.toLowerCase() ||
      !Array.isArray(p.grants) ||
      !integer(p.activeCount, 0) ||
      p.activeCount > 8 ||
      p.maxActive !== 8 ||
      typeof p.canManage !== 'boolean'
    )
      return { status: 'unavailable' };
    const grants: GroupBotGrant[] = [];
    const ids = new Set<string>();
    const activeBots = new Set<string>();
    for (const value of p.grants) {
      const grant = parseGrant(value, groupId);
      if (
        !grant ||
        ids.has(grant.id) ||
        (grant.closed === null && activeBots.has(grant.bot.id)) ||
        (grants[0] && grant.conversationId !== grants[0].conversationId)
      )
        return { status: 'unavailable' };
      ids.add(grant.id);
      if (grant.closed === null) activeBots.add(grant.bot.id);
      grants.push(grant);
    }
    if (activeBots.size !== p.activeCount) return { status: 'unavailable' };
    return {
      status: 'available',
      value: {
        groupId: groupId.toLowerCase(),
        grants,
        activeCount: p.activeCount,
        maxActive: 8,
        canManage: p.canManage,
      },
    };
  }
  async invite(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    input: { botId: string; idempotencyKey: string; history?: HistoryChoice },
  ): Promise<GroupBotResult<GroupBotGrant>> {
    if (
      (!keys(input, 'botId,idempotencyKey') && !keys(input, 'botId,history,idempotencyKey')) ||
      !isBotUuid(input.botId) ||
      !isCommandKey(input.idempotencyKey)
    )
      return { status: 'invalid' };
    const history = parseHistoryChoice(input.history ?? { mode: 'future-only' });
    if (!history) return { status: 'invalid' };
    const result = await this.send(session, workspaceId, groupId, '', 'POST', {
      botId: input.botId.toLowerCase(),
      idempotencyKey: input.idempotencyKey,
      history,
    });
    if (result.status !== 'available') return result;
    const grant = keys(result.value, 'grant') ? parseGrant(result.value.grant, groupId) : undefined;
    if (
      !grant ||
      grant.bot.id !== input.botId.toLowerCase() ||
      grant.history.mode !== history.mode ||
      (history.mode === 'since-event' &&
        (grant.history.mode !== 'since-event' || grant.history.eventId !== history.eventId)) ||
      (history.mode === 'since-time' &&
        (grant.history.mode !== 'since-time' || grant.history.time !== history.time))
    )
      return { status: 'unavailable' };
    return { status: 'available', value: grant };
  }
  async remove(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    grantId: string,
    input: { idempotencyKey: string },
  ): Promise<GroupBotResult<GroupBotGrant>> {
    if (
      !isBotUuid(grantId) ||
      !keys(input, 'idempotencyKey') ||
      !isCommandKey(input.idempotencyKey)
    )
      return { status: 'invalid' };
    const result = await this.send(
      session,
      workspaceId,
      groupId,
      `/${grantId.toLowerCase()}/remove`,
      'POST',
      input,
    );
    if (result.status !== 'available') return result;
    const grant = keys(result.value, 'grant') ? parseGrant(result.value.grant, groupId) : undefined;
    return grant?.id === grantId.toLowerCase() && grant.closed !== null
      ? { status: 'available', value: grant }
      : { status: 'unavailable' };
  }
  async context(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    grantId: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<GroupBotResult<GroupBotContext>> {
    if (
      !isBotUuid(grantId) ||
      Object.keys(query).some((key) => !['cursor', 'limit'].includes(key)) ||
      (query.cursor !== undefined && !isConversationCursor(query.cursor)) ||
      (query.limit !== undefined && (!integer(query.limit) || query.limit > 100))
    )
      return { status: 'invalid' };
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const result = await this.send(
      session,
      workspaceId,
      groupId,
      `/${grantId.toLowerCase()}/context${params.size ? `?${params}` : ''}`,
    );
    if (result.status !== 'available') return result;
    const p = result.value;
    if (
      !keys(p, 'conversationId,grantId,messages,nextCursor') ||
      !isBotUuid(p.grantId) ||
      p.grantId.toLowerCase() !== grantId.toLowerCase() ||
      !isBotUuid(p.conversationId) ||
      !Array.isArray(p.messages) ||
      p.messages.length > (query.limit ?? 30) ||
      (p.nextCursor !== null && !isConversationCursor(p.nextCursor))
    )
      return { status: 'unavailable' };
    const messages: MessageProjection[] = [];
    const ids = new Set<string>();
    for (const value of p.messages) {
      const message = projection(value);
      if (
        !message ||
        ids.has(message.id) ||
        (messages.at(-1)?.creationSequence ?? 0) >= message.creationSequence
      )
        return { status: 'unavailable' };
      messages.push(message);
      ids.add(message.id);
    }
    return {
      status: 'available',
      value: {
        grantId: grantId.toLowerCase(),
        conversationId: p.conversationId.toLowerCase(),
        messages,
        nextCursor: p.nextCursor,
      },
    };
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    suffix = '',
    method = 'GET',
    body?: unknown,
  ): Promise<GroupBotResult<unknown>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (!isBotUuid(workspaceId) || !isBotUuid(groupId)) return { status: 'invalid' };
    const controller = new AbortController();
    const signal = this.requestSignal
      ? AbortSignal.any([controller.signal, this.requestSignal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      signal.throwIfAborted();
      const response = await this.request(
        `${this.baseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/groups/${groupId.toLowerCase()}/bots${suffix}`,
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
      if (keys(payload, 'error') && keys(payload.error, 'code')) {
        const code = payload.error.code;
        if (
          response.status === 403 &&
          (code === 'group_bot_forbidden' || code === 'invalid_origin')
        )
          return { status: 'forbidden' };
        if (response.status === 400 && code === 'invalid_group_bot_request')
          return { status: 'invalid' };
        if (response.status === 409) {
          if (code === 'idempotency_conflict') return { status: 'idempotency-conflict' };
          if (code === 'group_bot_already_active') return { status: 'already-active' };
          if (code === 'group_bot_limit') return { status: 'limit' };
          if (code === 'group_bot_inactive') return { status: 'inactive' };
        }
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
export function createGroupBotApiClient(request: typeof fetch, signal?: AbortSignal) {
  return new GroupBotApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    signal,
  );
}

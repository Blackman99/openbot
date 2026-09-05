import { SESSION_COOKIE_NAME } from './auth-api.js';
import { isCommandKey, isConversationUuid, type MessageAuthor } from './conversation-api.js';

export interface MemoryScope {
  workspaceId: string;
  groupId: string;
  grantId?: string;
}
export interface MemoryCommand {
  messageId: string;
  expectedSourceEventId: string;
  confidence: number;
  idempotencyKey: string;
}
export interface Memory {
  id: string;
  versionId: string;
  version: 1;
  scope: { kind: 'group'; workspaceId: string; groupId: string };
  creator: { id: string; displayName: string };
  createdAt: string;
  confidence: number;
  confidenceSource: 'human';
  text: string;
  source: {
    conversationId: string;
    messageId: string;
    eventId: string;
    creationEventId: string;
    creationSequence: number;
    version: number;
    author: MessageAuthor;
    createdAt: string;
    updatedAt: string;
  };
}
export interface MemoryPage {
  memories: Memory[];
  nextAfter: string | null;
}
export type MemoryResult<T> =
  | { status: 'available'; value: T }
  | {
      status:
        | 'anonymous'
        | 'forbidden'
        | 'invalid'
        | 'version-conflict'
        | 'idempotency-conflict'
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
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
}
function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function confidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function author(value: unknown): MessageAuthor | undefined {
  if (keys(value, 'displayName,id') && isConversationUuid(value.id) && text(value.displayName, 200))
    return { id: value.id.toLowerCase(), displayName: value.displayName };
  if (
    keys(value, 'displayName,id,kind,versionId,versionNumber') &&
    value.kind === 'bot' &&
    isConversationUuid(value.id) &&
    text(value.displayName, 200) &&
    isConversationUuid(value.versionId) &&
    positive(value.versionNumber)
  )
    return {
      kind: 'bot',
      id: value.id.toLowerCase(),
      displayName: value.displayName,
      versionId: value.versionId.toLowerCase(),
      versionNumber: value.versionNumber,
    };
  return undefined;
}
function parseMemory(value: unknown, scope: MemoryScope): Memory | undefined {
  if (
    !keys(
      value,
      'confidence,confidenceSource,createdAt,creator,id,scope,source,text,version,versionId',
    ) ||
    !isConversationUuid(value.id) ||
    !isConversationUuid(value.versionId) ||
    value.version !== 1 ||
    !confidence(value.confidence) ||
    value.confidenceSource !== 'human' ||
    !text(value.text, 32000) ||
    !date(value.createdAt) ||
    !keys(value.scope, 'groupId,kind,workspaceId') ||
    value.scope.kind !== 'group' ||
    !isConversationUuid(value.scope.workspaceId) ||
    !isConversationUuid(value.scope.groupId) ||
    value.scope.workspaceId.toLowerCase() !== scope.workspaceId.toLowerCase() ||
    value.scope.groupId.toLowerCase() !== scope.groupId.toLowerCase() ||
    !keys(value.creator, 'displayName,id') ||
    !isConversationUuid(value.creator.id) ||
    !text(value.creator.displayName, 200) ||
    !keys(
      value.source,
      'author,conversationId,createdAt,creationEventId,creationSequence,eventId,messageId,updatedAt,version',
    ) ||
    !isConversationUuid(value.source.conversationId) ||
    !isConversationUuid(value.source.messageId) ||
    !isConversationUuid(value.source.eventId) ||
    !isConversationUuid(value.source.creationEventId) ||
    !positive(value.source.creationSequence) ||
    !positive(value.source.version) ||
    !date(value.source.createdAt) ||
    !date(value.source.updatedAt)
  )
    return undefined;
  const sourceAuthor = author(value.source.author);
  if (
    !sourceAuthor ||
    (value.source.version === 1) !==
      (value.source.eventId.toLowerCase() === value.source.creationEventId.toLowerCase()) ||
    ('kind' in sourceAuthor && value.source.version !== 1)
  )
    return undefined;
  return {
    id: value.id.toLowerCase(),
    versionId: value.versionId.toLowerCase(),
    version: 1,
    scope: {
      kind: 'group',
      workspaceId: value.scope.workspaceId.toLowerCase(),
      groupId: value.scope.groupId.toLowerCase(),
    },
    creator: { id: value.creator.id.toLowerCase(), displayName: value.creator.displayName },
    createdAt: value.createdAt,
    confidence: value.confidence,
    confidenceSource: 'human',
    text: value.text,
    source: {
      conversationId: value.source.conversationId.toLowerCase(),
      messageId: value.source.messageId.toLowerCase(),
      eventId: value.source.eventId.toLowerCase(),
      creationEventId: value.source.creationEventId.toLowerCase(),
      creationSequence: value.source.creationSequence,
      version: value.source.version,
      author: sourceAuthor,
      createdAt: value.source.createdAt,
      updatedAt: value.source.updatedAt,
    },
  };
}
type Read = { after?: string; limit?: number };
function readValid(read: Read) {
  return (
    (read.after === undefined || isConversationUuid(read.after)) &&
    (read.limit === undefined || (positive(read.limit) && read.limit <= 100))
  );
}
export class MemoryApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
    private readonly signal?: AbortSignal,
  ) {}
  async create(
    session: string | undefined,
    scope: MemoryScope,
    command: MemoryCommand,
  ): Promise<MemoryResult<Memory>> {
    if (
      scope.grantId ||
      !isConversationUuid(command.messageId) ||
      !isConversationUuid(command.expectedSourceEventId) ||
      !isCommandKey(command.idempotencyKey) ||
      !confidence(command.confidence)
    )
      return { status: 'invalid' };
    const result = await this.send(
      session,
      scope,
      '',
      'POST',
      {
        messageId: command.messageId.toLowerCase(),
        expectedSourceEventId: command.expectedSourceEventId.toLowerCase(),
        idempotencyKey: command.idempotencyKey,
        confidence: command.confidence,
      },
      true,
    );
    if (result.status !== 'available') return result;
    const memory = keys(result.value, 'memory')
      ? parseMemory(result.value.memory, scope)
      : undefined;
    return memory &&
      memory.source.messageId === command.messageId.toLowerCase() &&
      memory.source.eventId === command.expectedSourceEventId.toLowerCase() &&
      memory.confidence === command.confidence
      ? { status: 'available', value: memory }
      : { status: 'unavailable' };
  }
  async get(
    session: string | undefined,
    scope: MemoryScope,
    memoryId: string,
  ): Promise<MemoryResult<Memory>> {
    if (!isConversationUuid(memoryId)) return { status: 'invalid' };
    const result = await this.send(session, scope, `/${memoryId.toLowerCase()}`);
    if (result.status !== 'available') return result;
    const memory = keys(result.value, 'memory')
      ? parseMemory(result.value.memory, scope)
      : undefined;
    return memory?.id === memoryId.toLowerCase()
      ? { status: 'available', value: memory }
      : { status: 'unavailable' };
  }
  async list(
    session: string | undefined,
    scope: MemoryScope,
    read: Read = {},
  ): Promise<MemoryResult<MemoryPage>> {
    if (!readValid(read)) return { status: 'invalid' };
    const query = new URLSearchParams();
    if (read.after) query.set('after', read.after.toLowerCase());
    if (read.limit !== undefined) query.set('limit', String(read.limit));
    return this.page(await this.send(session, scope, query.size ? `?${query}` : ''), scope, read);
  }
  async search(
    session: string | undefined,
    scope: MemoryScope,
    read: Read & { query: string },
  ): Promise<MemoryResult<MemoryPage>> {
    if (
      !readValid(read) ||
      typeof read.query !== 'string' ||
      read.query.length > 200 ||
      Buffer.byteLength(read.query) > 800
    )
      return { status: 'invalid' };
    return this.page(
      await this.send(session, scope, '/search', 'POST', {
        query: read.query,
        ...(read.limit === undefined ? {} : { limit: read.limit }),
        ...(read.after === undefined ? {} : { after: read.after.toLowerCase() }),
      }),
      scope,
      read,
    );
  }
  private page(
    result: MemoryResult<unknown>,
    scope: MemoryScope,
    read: Read,
  ): MemoryResult<MemoryPage> {
    if (result.status !== 'available') return result;
    const value = result.value;
    if (
      !keys(value, 'memories,nextAfter') ||
      !Array.isArray(value.memories) ||
      value.memories.length > (read.limit ?? 30) ||
      (value.nextAfter !== null && !isConversationUuid(value.nextAfter))
    )
      return { status: 'unavailable' };
    const memories: Memory[] = [];
    for (const item of value.memories) {
      const memory = parseMemory(item, scope);
      if (!memory || memory.id <= (memories.at(-1)?.id ?? read.after?.toLowerCase() ?? ''))
        return { status: 'unavailable' };
      memories.push(memory);
    }
    const nextAfter = value.nextAfter === null ? null : value.nextAfter.toLowerCase();
    return nextAfter !== null && nextAfter !== memories.at(-1)?.id
      ? { status: 'unavailable' }
      : { status: 'available', value: { memories, nextAfter } };
  }
  private async send(
    session: string | undefined,
    scope: MemoryScope,
    suffix = '',
    method = 'GET',
    body?: unknown,
    creating = false,
  ): Promise<MemoryResult<unknown>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (
      !isConversationUuid(scope.workspaceId) ||
      !isConversationUuid(scope.groupId) ||
      (scope.grantId !== undefined && !isConversationUuid(scope.grantId))
    )
      return { status: 'invalid' };
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.request(
        `${this.baseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${scope.workspaceId.toLowerCase()}/groups/${scope.groupId.toLowerCase()}${scope.grantId ? `/bots/${scope.grantId.toLowerCase()}` : ''}/memories${suffix}`,
        {
          method,
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${session}`,
            origin: new URL(this.webOrigin).origin,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: this.signal
            ? AbortSignal.any([this.signal, controller.signal])
            : controller.signal,
        },
      );
      if (response.status === 401) return { status: 'anonymous' };
      const payload: unknown = await response.json();
      if (keys(payload, 'error') && keys(payload.error, 'code')) {
        if (response.status === 403 && payload.error.code === 'memory_forbidden')
          return { status: 'forbidden' };
        if (response.status === 400 && payload.error.code === 'invalid_memory_request')
          return { status: 'invalid' };
        if (response.status === 409 && payload.error.code === 'source_version_conflict')
          return { status: 'version-conflict' };
        if (response.status === 409 && payload.error.code === 'idempotency_conflict')
          return { status: 'idempotency-conflict' };
      }
      return response.status === 200 || (creating && response.status === 201)
        ? { status: 'available', value: payload }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
export function createMemoryApiClient(request: typeof fetch, signal?: AbortSignal) {
  return new MemoryApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    signal,
  );
}

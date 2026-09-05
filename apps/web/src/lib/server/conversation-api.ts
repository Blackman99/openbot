import { isBotLifecycleState, type BotLifecycleState } from './bot-api.js';
import { parseAttachment } from './attachment-contract.js';
import { SESSION_COOKIE_NAME } from './auth-api.js';
export interface ConversationSubject {
  kind: 'group' | 'direct-bot';
  id: string;
}
export interface Conversation {
  botLifecycleState?: BotLifecycleState;
  id: string;
  workspaceId: string;
  subject: ConversationSubject;
  createdAt: string;
}
export interface MessageReceipt {
  messageId: string;
  eventId: string;
  sequence: number;
}
export interface MessageCommand {
  idempotencyKey: string;
  body: string;
}
export interface MessageEditCommand extends MessageCommand {
  expectedVersion: number;
}
export interface TombstoneCommand {
  idempotencyKey: string;
  expectedVersion: number;
  reason?: string;
}
export type MessageAuthor =
  | { id: string; displayName: string }
  | { kind: 'bot'; id: string; displayName: string; versionId: string; versionNumber: number };
export interface MessageProjection {
  attachment?: NonNullable<ReturnType<typeof parseAttachment>>;
  id: string;
  creationSequence: number;
  versionEventId: string;
  sequence: number;
  version: number;
  author: MessageAuthor;
  body: string | null;
  reason: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
  canAudit: boolean;
}
export interface ConversationPage {
  conversation: Conversation;
  messages: MessageProjection[];
  nextCursor: string | null;
  canWrite: boolean;
}
export interface MessageVersion {
  id: string;
  sequence: number;
  type: 'message.created' | 'message.edited' | 'message.deleted';
  version: number;
  actor: { id: string; displayName: string };
  occurredAt: string;
  body: string | null;
  reason: string | null;
}
export type ConversationResult<T> =
  | { status: 'available'; value: T }
  | {
      status:
        | 'anonymous'
        | 'forbidden'
        | 'invalid'
        | 'idempotency-conflict'
        | 'version-conflict'
        | 'unavailable';
    };
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
export function isConversationUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
export function isConversationCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/u.test(value);
}
export function isCommandKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/u.test(value);
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
}
function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function actor(value: unknown) {
  return keys(value, 'displayName,id') &&
    isConversationUuid(value.id) &&
    text(value.displayName, 200)
    ? { id: value.id.toLowerCase(), displayName: value.displayName }
    : undefined;
}
function messageAuthor(value: unknown): MessageAuthor | undefined {
  const person = actor(value);
  if (person) return person;
  if (
    !keys(value, 'displayName,id,kind,versionId,versionNumber') ||
    value.kind !== 'bot' ||
    !isConversationUuid(value.id) ||
    !isConversationUuid(value.versionId) ||
    !positive(value.versionNumber) ||
    !text(value.displayName, 100)
  )
    return undefined;
  return {
    kind: 'bot',
    id: value.id.toLowerCase(),
    displayName: value.displayName,
    versionId: value.versionId.toLowerCase(),
    versionNumber: value.versionNumber,
  };
}
function parseConversation(value: unknown, workspaceId: string): Conversation | undefined {
  if (
    (!keys(value, 'createdAt,id,subject,workspaceId') &&
      !keys(value, 'botLifecycleState,createdAt,id,subject,workspaceId')) ||
    !isConversationUuid(value.id) ||
    !isConversationUuid(value.workspaceId) ||
    value.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
    !keys(value.subject, 'id,kind') ||
    !isConversationUuid(value.subject.id) ||
    (value.subject.kind !== 'group' && value.subject.kind !== 'direct-bot') ||
    !date(value.createdAt) ||
    (value.subject.kind === 'direct-bot'
      ? !isBotLifecycleState(value.botLifecycleState)
      : 'botLifecycleState' in value)
  )
    return undefined;
  return {
    id: value.id.toLowerCase(),
    workspaceId: value.workspaceId.toLowerCase(),
    subject: { kind: value.subject.kind, id: value.subject.id.toLowerCase() },
    ...(isBotLifecycleState(value.botLifecycleState)
      ? { botLifecycleState: value.botLifecycleState }
      : {}),
    createdAt: value.createdAt,
  };
}
function projection(value: unknown): MessageProjection | undefined {
  if (
    !keys(
      value,
      (value && typeof value === 'object' && 'attachment' in value ? 'attachment,' : '') +
        'author,body,canAudit,canDelete,canEdit,createdAt,creationSequence,deleted,id,reason,sequence,updatedAt,version,versionEventId',
    ) ||
    !isConversationUuid(value.id) ||
    !isConversationUuid(value.versionEventId) ||
    !positive(value.creationSequence) ||
    !positive(value.sequence) ||
    value.sequence < value.creationSequence ||
    !positive(value.version) ||
    typeof value.deleted !== 'boolean' ||
    !date(value.createdAt) ||
    !date(value.updatedAt) ||
    typeof value.canEdit !== 'boolean' ||
    typeof value.canDelete !== 'boolean' ||
    typeof value.canAudit !== 'boolean'
  )
    return undefined;
  if (
    value.deleted
      ? value.body !== null || !text(value.reason, 500) || value.canEdit || value.canDelete
      : !text(value.body, 32000) || value.reason !== null
  )
    return undefined;
  const attachment = value.attachment === undefined ? undefined : parseAttachment(value.attachment);
  if (value.attachment !== undefined && (!attachment || value.deleted)) return undefined;
  const author = messageAuthor(value.author);
  if (!author || ('kind' in author && (value.canEdit || value.canDelete || value.canAudit)))
    return undefined;
  return {
    ...(attachment ? { attachment } : {}),
    id: value.id.toLowerCase(),
    creationSequence: value.creationSequence,
    versionEventId: value.versionEventId.toLowerCase(),
    sequence: value.sequence,
    version: value.version,
    author,
    body: typeof value.body === 'string' ? value.body : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    deleted: value.deleted,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    canEdit: value.canEdit,
    canDelete: value.canDelete,
    canAudit: value.canAudit,
  };
}
function parseVersion(value: unknown): MessageVersion | undefined {
  if (
    !keys(value, 'actor,body,id,occurredAt,reason,sequence,type,version') ||
    !isConversationUuid(value.id) ||
    !positive(value.sequence) ||
    !positive(value.version) ||
    !date(value.occurredAt) ||
    !['message.created', 'message.edited', 'message.deleted'].includes(String(value.type))
  )
    return undefined;
  if (
    value.type === 'message.deleted'
      ? value.body !== null || !text(value.reason, 500)
      : !text(value.body, 32000) || value.reason !== null
  )
    return undefined;
  const person = actor(value.actor);
  if (!person) return undefined;
  return {
    id: value.id.toLowerCase(),
    sequence: value.sequence,
    version: value.version,
    actor: person,
    occurredAt: value.occurredAt,
    type:
      value.type === 'message.created'
        ? 'message.created'
        : value.type === 'message.edited'
          ? 'message.edited'
          : 'message.deleted',
    body: typeof value.body === 'string' ? value.body : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
  };
}
export class ConversationApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}
  async open(
    session: string | undefined,
    workspaceId: string,
    subject: ConversationSubject,
  ): Promise<ConversationResult<Conversation>> {
    if (
      !isConversationUuid(subject.id) ||
      (subject.kind !== 'group' && subject.kind !== 'direct-bot')
    )
      return { status: 'invalid' };
    const result = await this.send(session, workspaceId, undefined, '', 'POST', {
      subject: { kind: subject.kind, id: subject.id.toLowerCase() },
    });
    if (result.status !== 'available') return result;
    const conversation = keys(result.value, 'conversation')
      ? parseConversation(result.value.conversation, workspaceId)
      : undefined;
    return conversation &&
      conversation.subject.kind === subject.kind &&
      conversation.subject.id === subject.id.toLowerCase()
      ? { status: 'available', value: conversation }
      : { status: 'unavailable' };
  }
  async append(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    command: MessageCommand,
  ): Promise<ConversationResult<MessageReceipt>> {
    if (!isCommandKey(command.idempotencyKey) || !text(command.body, 32000))
      return { status: 'invalid' };
    return this.receipt(
      await this.send(session, workspaceId, conversationId, '/messages', 'POST', {
        idempotencyKey: command.idempotencyKey,
        body: command.body,
      }),
    );
  }
  async edit(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    messageId: string,
    command: MessageEditCommand,
  ): Promise<ConversationResult<MessageReceipt>> {
    if (
      !isConversationUuid(messageId) ||
      !isCommandKey(command.idempotencyKey) ||
      !positive(command.expectedVersion) ||
      !text(command.body, 32000)
    )
      return { status: 'invalid' };
    return this.receipt(
      await this.send(
        session,
        workspaceId,
        conversationId,
        `/messages/${messageId.toLowerCase()}`,
        'PATCH',
        {
          idempotencyKey: command.idempotencyKey,
          expectedVersion: command.expectedVersion,
          body: command.body,
        },
      ),
      messageId,
    );
  }
  async tombstone(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    messageId: string,
    command: TombstoneCommand,
  ): Promise<ConversationResult<MessageReceipt>> {
    if (
      !isConversationUuid(messageId) ||
      !isCommandKey(command.idempotencyKey) ||
      !positive(command.expectedVersion) ||
      (command.reason !== undefined && !text(command.reason.trim(), 500))
    )
      return { status: 'invalid' };
    return this.receipt(
      await this.send(
        session,
        workspaceId,
        conversationId,
        `/messages/${messageId.toLowerCase()}/tombstone`,
        'POST',
        {
          idempotencyKey: command.idempotencyKey,
          expectedVersion: command.expectedVersion,
          ...(command.reason === undefined ? {} : { reason: command.reason.trim() }),
        },
      ),
      messageId,
    );
  }
  private receipt(
    result: ConversationResult<unknown>,
    messageId?: string,
  ): ConversationResult<MessageReceipt> {
    if (result.status !== 'available') return result;
    const value = keys(result.value, 'receipt') ? result.value.receipt : undefined;
    return keys(value, 'eventId,messageId,sequence') &&
      isConversationUuid(value.messageId) &&
      isConversationUuid(value.eventId) &&
      positive(value.sequence) &&
      (messageId === undefined || value.messageId.toLowerCase() === messageId.toLowerCase())
      ? {
          status: 'available',
          value: {
            messageId: value.messageId.toLowerCase(),
            eventId: value.eventId.toLowerCase(),
            sequence: value.sequence,
          },
        }
      : { status: 'unavailable' };
  }
  async versions(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    messageId: string,
  ): Promise<ConversationResult<MessageVersion[]>> {
    if (!isConversationUuid(messageId)) return { status: 'invalid' };
    const result = await this.send(
      session,
      workspaceId,
      conversationId,
      `/messages/${messageId.toLowerCase()}/versions`,
    );
    if (result.status !== 'available') return result;
    if (
      !keys(result.value, 'versions') ||
      !Array.isArray(result.value.versions) ||
      !result.value.versions.length
    )
      return { status: 'unavailable' };
    const versions: MessageVersion[] = [];
    const ids = new Set<string>();
    for (const item of result.value.versions) {
      const version = parseVersion(item);
      if (
        !version ||
        version.version !== versions.length + 1 ||
        ids.has(version.id) ||
        (versions.at(-1)?.sequence ?? 0) >= version.sequence ||
        versions.at(-1)?.type === 'message.deleted' ||
        (versions.length === 0
          ? version.type !== 'message.created'
          : version.type === 'message.created')
      )
        return { status: 'unavailable' };
      ids.add(version.id);
      versions.push(version);
    }
    return { status: 'available', value: versions };
  }
  async get(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    query: { cursor?: string; limit?: number; messageId?: string } = {},
  ): Promise<ConversationResult<ConversationPage>> {
    if (
      (query.cursor !== undefined && !isConversationCursor(query.cursor)) ||
      (query.messageId !== undefined &&
        (!isConversationUuid(query.messageId) || query.cursor !== undefined)) ||
      (query.limit !== undefined && (!positive(query.limit) || query.limit > 100))
    )
      return { status: 'invalid' };
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.messageId !== undefined) params.set('messageId', query.messageId.toLowerCase());
    const result = await this.send(
      session,
      workspaceId,
      conversationId,
      params.size ? `?${params}` : '',
    );
    if (result.status !== 'available') return result;
    const payload = result.value;
    if (
      !keys(payload, 'canWrite,conversation,messages,nextCursor') ||
      !Array.isArray(payload.messages) ||
      payload.messages.length > (query.limit ?? 30) ||
      (payload.nextCursor !== null && !isConversationCursor(payload.nextCursor)) ||
      typeof payload.canWrite !== 'boolean'
    )
      return { status: 'unavailable' };
    const conversation = parseConversation(payload.conversation, workspaceId);
    if (!conversation || conversation.id !== conversationId.toLowerCase())
      return { status: 'unavailable' };
    const messages: MessageProjection[] = [];
    const ids = new Set<string>();
    for (const item of payload.messages) {
      const message = projection(item);
      if (
        !message ||
        ids.has(message.id) ||
        (messages.at(-1)?.creationSequence ?? 0) >= message.creationSequence
      )
        return { status: 'unavailable' };
      ids.add(message.id);
      messages.push(message);
    }
    if (query.messageId !== undefined && !ids.has(query.messageId.toLowerCase()))
      return { status: 'unavailable' };
    return {
      status: 'available',
      value: { conversation, messages, nextCursor: payload.nextCursor, canWrite: payload.canWrite },
    };
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    conversationId?: string,
    suffix = '',
    method = 'GET',
    body?: unknown,
  ): Promise<ConversationResult<unknown>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (
      !isConversationUuid(workspaceId) ||
      (conversationId !== undefined && !isConversationUuid(conversationId))
    )
      return { status: 'invalid' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.request(
        `${this.baseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/conversations${conversationId === undefined ? '' : `/${conversationId.toLowerCase()}`}${suffix}`,
        {
          method,
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${session}`,
            origin: new URL(this.webOrigin).origin,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        },
      );
      if (response.status === 401) return { status: 'anonymous' };
      const payload: unknown = await response.json();
      if (keys(payload, 'error') && keys(payload.error, 'code')) {
        if (
          response.status === 403 &&
          ['conversation_forbidden', 'invalid_origin'].includes(String(payload.error.code))
        )
          return { status: 'forbidden' };
        if (response.status === 400 && payload.error.code === 'invalid_conversation_request')
          return { status: 'invalid' };
        if (response.status === 409 && payload.error.code === 'idempotency_conflict')
          return { status: 'idempotency-conflict' };
        if (response.status === 409 && payload.error.code === 'message_version_conflict')
          return { status: 'version-conflict' };
      }
      return response.status === 200
        ? { status: 'available', value: payload }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
export function createConversationApiClient(request: typeof fetch) {
  return new ConversationApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}

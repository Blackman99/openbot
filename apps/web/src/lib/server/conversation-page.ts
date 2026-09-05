import { uploadAttachment, attachmentMaximum } from './attachment-page.js';
import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { createAuthApiClient } from './auth-api.js';
import { createWorkspaceApiClient } from './workspace-api.js';
import { createGroupApiClient } from './group-api.js';
import { createBotApiClient } from './bot-api.js';
import { createTaskApiClient, type TaskView } from './task-api.js';
import { readTaskRoutingDecision } from './task-routing.js';
import type { RoutingDecision } from '../routing-contract.js';
import {
  createConversationApiClient,
  isCommandKey,
  isConversationCursor,
  isConversationUuid,
  type ConversationSubject,
} from './conversation-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type ConversationAction = 'open' | 'append' | 'edit' | 'tombstone';
function pageQuery(url: URL) {
  const cursor = url.searchParams.get('cursor');
  const limit = url.searchParams.get('limit');
  const messageId = url.searchParams.get('messageId');
  if (
    url.searchParams.getAll('cursor').length > 1 ||
    url.searchParams.getAll('limit').length > 1 ||
    url.searchParams.getAll('messageId').length > 1 ||
    (messageId !== null && (!isConversationUuid(messageId) || cursor !== null)) ||
    (cursor !== null && !isConversationCursor(cursor)) ||
    (limit !== null && (!/^[1-9][0-9]{0,2}$/u.test(limit) || Number(limit) > 100))
  )
    error(400, 'Invalid conversation page request');
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(messageId === null ? {} : { messageId: messageId.toLowerCase() }),
  };
}
export async function loadConversationPage(
  context: PageContext & Pick<RequestEvent, 'url'> & Partial<Pick<RequestEvent, 'request'>>,
  workspaceId: string,
  conversationId: string,
) {
  const routingTaskId = context.url.searchParams.get('routingTaskId');
  if (
    context.url.searchParams.getAll('routingTaskId').length > 1 ||
    (routingTaskId !== null && !isConversationUuid(routingTaskId))
  )
    readFailure('invalid', context);
  const page = await requireWorkspace(context, workspaceId);
  const query = pageQuery(context.url);
  const result = await createConversationApiClient(context.fetch).get(
    readSessionCookie(context.cookies),
    workspaceId,
    conversationId,
    query,
  );
  if (result.status !== 'available') readFailure(result.status, context);
  let selectedRouting: { task: TaskView; decision: RoutingDecision } | undefined;
  if (routingTaskId !== null) {
    const session = readSessionCookie(context.cookies);
    const task = await createTaskApiClient(context.fetch, context.request?.signal).get(
      session,
      workspaceId,
      conversationId,
      routingTaskId,
    );
    if (task.status !== 'available') readFailure(task.status, context);
    const decision = await readTaskRoutingDecision(
      context.fetch,
      session,
      workspaceId,
      conversationId,
      task.value,
      context.request?.signal,
    );
    if (decision.status !== 'available') readFailure(decision.status, context);
    if (decision.value === null) readFailure('forbidden', context);
    selectedRouting = { task: task.value, decision: decision.value };
  }
  const messages: Record<string, { edit: string; tombstone: string; saveMemory: string }> = {};
  for (const message of result.value.messages)
    messages[message.id] = {
      edit: randomUUID(),
      tombstone: randomUUID(),
      saveMemory: randomUUID(),
    };
  const append: string = randomUUID();
  return {
    ...page,
    ...result.value,
    ...(selectedRouting === undefined ? {} : { selectedRouting }),
    attachmentMaximum: attachmentMaximum(),
    cursor: query.cursor ?? null,
    limit: query.limit ?? 30,
    commands: { append, messages },
  };
}
export async function loadMessageVersionsPage(
  context: PageContext,
  workspaceId: string,
  conversationId: string,
  messageId: string,
) {
  const page = await requireWorkspace(context, workspaceId);
  const result = await createConversationApiClient(context.fetch).versions(
    readSessionCookie(context.cookies),
    workspaceId,
    conversationId,
    messageId,
  );
  if (result.status !== 'available') readFailure(result.status, context);
  return {
    ...page,
    conversationId: conversationId.toLowerCase(),
    messageId: messageId.toLowerCase(),
    versions: result.value,
  };
}
function actionFailure(
  status: string,
  context: PageContext,
  action: ConversationAction,
  values: Record<string, string>,
) {
  if (status === 'anonymous') readFailure(status, context);
  const conflict = status === 'idempotency-conflict' || status === 'version-conflict';
  const error =
    status === 'forbidden'
      ? 'You no longer have permission for this conversation or message.'
      : status === 'invalid'
        ? 'Choose an allowed attachment within the configured limit and use a nonblank message of up to 32,000 characters and valid command fields. A moderation reason is required when deleting another person’s message.'
        : status === 'version-conflict'
          ? 'This message changed. Your draft is preserved. Refresh messages to load its latest version before editing again.'
          : status === 'idempotency-conflict'
            ? 'This command key was already used for different content. Your draft is preserved. Refresh messages to start a new command.'
            : 'The change could not be confirmed. Retry the unchanged form with the same command key.';
  return fail(status === 'forbidden' ? 403 : status === 'invalid' ? 400 : conflict ? 409 : 503, {
    action,
    values,
    error,
    conflict,
  });
}
export async function conversationAction(
  context: PageContext & Pick<RequestEvent, 'request' | 'url'>,
  workspaceId: string,
  conversationId: string | undefined,
  action: ConversationAction,
) {
  preventAuthenticationCaching(context.setHeaders);
  const allowed =
    action === 'open'
      ? ['kind', 'subjectId']
      : action === 'append'
        ? ['idempotencyKey', 'body', 'attachment']
        : action === 'edit'
          ? ['idempotencyKey', 'messageId', 'expectedVersion', 'body']
          : ['idempotencyKey', 'messageId', 'expectedVersion', 'reason'];
  const values: Record<string, string> = {};
  let invalid = false;
  let attachment: File | undefined;
  try {
    const form = await context.request.formData();
    for (const [key, value] of form) {
      if (
        action === 'append' &&
        key === 'attachment' &&
        value instanceof File &&
        form.getAll(key).length === 1
      ) {
        if (value.name || value.size) attachment = value;
        continue;
      }
      if (!allowed.includes(key) || typeof value !== 'string' || form.getAll(key).length !== 1)
        invalid = true;
      if (allowed.includes(key) && typeof value === 'string')
        values[key] = key === 'body' ? value.replace(/\r\n/gu, '\n') : value;
    }
  } catch {
    invalid = true;
  }
  if (invalid) return actionFailure('invalid', context, action, values);
  const client = createConversationApiClient(context.fetch);
  const session = readSessionCookie(context.cookies);
  if (action === 'open') {
    if (
      !isConversationUuid(values.subjectId) ||
      (values.kind !== 'group' && values.kind !== 'direct-bot')
    )
      return actionFailure('invalid', context, action, values);
    const result = await client.open(session, workspaceId, {
      kind: values.kind,
      id: values.subjectId,
    });
    if (result.status !== 'available') return actionFailure(result.status, context, action, values);
    redirect(303, `/app/workspaces/${result.value.workspaceId}/conversations/${result.value.id}`);
  }
  if (!isConversationUuid(conversationId) || !isCommandKey(values.idempotencyKey))
    return actionFailure('invalid', context, action, values);
  const query = pageQuery(context.url);
  if (
    action !== 'append' &&
    (!isConversationUuid(values.messageId) ||
      !/^[1-9][0-9]*$/u.test(values.expectedVersion ?? '') ||
      !Number.isSafeInteger(Number(values.expectedVersion)))
  )
    return actionFailure('invalid', context, action, values);
  if (
    action !== 'tombstone' &&
    (typeof values.body !== 'string' || !values.body.trim() || values.body.length > 32000)
  )
    return actionFailure('invalid', context, action, values);
  const result =
    action === 'append' && attachment
      ? await uploadAttachment(context, workspaceId, conversationId, values, attachment)
      : action === 'append'
        ? await client.append(session, workspaceId, conversationId, {
            idempotencyKey: values.idempotencyKey,
            body: values.body,
          })
        : action === 'edit'
          ? await client.edit(session, workspaceId, conversationId, values.messageId, {
              idempotencyKey: values.idempotencyKey,
              expectedVersion: Number(values.expectedVersion),
              body: values.body,
            })
          : await client.tombstone(session, workspaceId, conversationId, values.messageId, {
              idempotencyKey: values.idempotencyKey,
              expectedVersion: Number(values.expectedVersion),
              ...(values.reason?.trim() ? { reason: values.reason } : {}),
            });
  if (result.status !== 'available') return actionFailure(result.status, context, action, values);
  const params = new URLSearchParams();
  if (action !== 'append' && query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  redirect(
    303,
    `/app/workspaces/${workspaceId.toLowerCase()}/conversations/${conversationId.toLowerCase()}${params.size ? `?${params}` : ''}#message-${result.value.messageId}`,
  );
}
function readFailure(status: string, context: PageContext): never {
  if (status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden') error(403, 'You cannot access this conversation or workspace');
  if (status === 'invalid') error(400, 'Invalid conversation or page request');
  error(503, 'Conversation service unavailable');
}
async function requireWorkspace(context: PageContext, workspaceId: string) {
  preventAuthenticationCaching(context.setHeaders);
  if (!isConversationUuid(workspaceId)) readFailure('invalid', context);
  const session = readSessionCookie(context.cookies);
  const identity = await createAuthApiClient(context.fetch).getIdentity(session);
  if (identity.status !== 'authenticated') readFailure(identity.status, context);
  const result = await createWorkspaceApiClient(context.fetch).list(session);
  if (result.status !== 'available') readFailure(result.status, context);
  const workspace = result.value.find(({ id }) => id === workspaceId.toLowerCase());
  if (!workspace) readFailure('forbidden', context);
  return { user: identity.identity.user, workspace, workspaces: result.value };
}
export { requireWorkspace as requireConversationWorkspace };
export async function loadConversationsPage(context: PageContext, workspaceId: string) {
  const page = await requireWorkspace(context, workspaceId);
  const session = readSessionCookie(context.cookies);
  const [groups, bots] = await Promise.all([
    createGroupApiClient(context.fetch).list(session, workspaceId),
    createBotApiClient(context.fetch).list(session, workspaceId),
  ]);
  if (groups.status !== 'available') readFailure(groups.status, context);
  if (bots.status !== 'available') readFailure(bots.status, context);
  const subjects: Array<ConversationSubject & { name: string }> = [];
  for (const group of groups.value)
    if (group.role !== null)
      subjects.push({ kind: 'group', id: group.id.toLowerCase(), name: group.name });
  for (const bot of bots.value)
    if (bot.accessRole !== null && bot.lifecycleState === 'active')
      subjects.push({ kind: 'direct-bot', id: bot.id, name: bot.name });
  const ids = new Set<string>();
  for (const subject of subjects) {
    const key = `${subject.kind}:${subject.id}`;
    if (!isConversationUuid(subject.id) || ids.has(key)) readFailure('unavailable', context);
    ids.add(key);
  }
  return { ...page, subjects };
}

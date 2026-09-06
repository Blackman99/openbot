import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createAuthApiClient } from './auth-api.js';
import { createWorkspaceApiClient } from './workspace-api.js';
import { createGroupApiClient } from './group-api.js';
import { createGroupBotApiClient } from './group-bot-api.js';
import {
  createConversationApiClient,
  isCommandKey,
  isConversationUuid,
} from './conversation-api.js';
import { createMemoryApiClient, type MemoryScope } from './memory-api.js';
import { createBotApiClient } from './bot-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
function readFailure(status: string, context: Context): never {
  if (status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden' || status === 'not-found')
    error(
      403,
      'This memory or its current source is not available with your current group access.',
    );
  if (status === 'invalid') error(400, 'Invalid memory request');
  error(503, 'Memories unavailable');
}
async function scope(context: Context, workspaceId: string, groupId: string) {
  preventAuthenticationCaching(context.setHeaders);
  if (!isConversationUuid(workspaceId) || !isConversationUuid(groupId))
    readFailure('invalid', context);
  const session = readSessionCookie(context.cookies);
  const identity = await createAuthApiClient(context.fetch).getIdentity(session);
  if (identity.status !== 'authenticated') readFailure(identity.status, context);
  const workspaces = await createWorkspaceApiClient(context.fetch).list(session);
  if (workspaces.status !== 'available') readFailure(workspaces.status, context);
  const workspace = workspaces.value.find((item) => item.id === workspaceId.toLowerCase());
  if (!workspace) readFailure('forbidden', context);
  const group = await createGroupApiClient(context.fetch).get(session, workspace.id, groupId);
  if (group.status !== 'available') readFailure(group.status, context);
  if (group.value.role === null) readFailure('forbidden', context);
  return {
    user: identity.identity.user,
    workspace,
    workspaces: workspaces.value,
    group: group.value,
  };
}
function pageQuery(url: URL, searchAction = false) {
  const allowed = searchAction ? ['grantId', 'after', '/search'] : ['grantId', 'after'];
  if (
    [...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
    url.searchParams.getAll('grantId').length > 1 ||
    url.searchParams.getAll('after').length > 1 ||
    url.searchParams.getAll('/search').length > 1 ||
    (url.searchParams.has('/search') && url.searchParams.get('/search') !== '')
  )
    error(400, 'Invalid memory page request');
  const grantId = url.searchParams.get('grantId') ?? '',
    after = url.searchParams.get('after');
  if ((grantId && !isConversationUuid(grantId)) || (after !== null && !isConversationUuid(after)))
    error(400, 'Invalid memory page request');
  return { grantId: grantId.toLowerCase(), ...(after ? { after: after.toLowerCase() } : {}) };
}
export async function loadMemoriesPage(
  context: Context & Pick<RequestEvent, 'url'>,
  workspaceId: string,
  groupId: string,
) {
  const query = pageQuery(context.url, true),
    page = await scope(context, workspaceId, groupId);
  const session = readSessionCookie(context.cookies);
  const membership = await createGroupBotApiClient(context.fetch).list(
    session,
    workspaceId,
    groupId,
  );
  if (membership.status !== 'available') readFailure(membership.status, context);
  const selected: MemoryScope = {
    workspaceId,
    groupId,
    ...(query.grantId ? { grantId: query.grantId } : {}),
  };
  const result = await createMemoryApiClient(context.fetch).list(
    session,
    selected,
    query.after ? { after: query.after } : {},
  );
  if (result.status !== 'available') readFailure(result.status, context);
  const grants = membership.value.grants.filter((grant) => grant.closed === null);
  if (query.grantId) {
    const grant = grants.find((item) => item.id === query.grantId);
    if (
      !grant ||
      result.value.memories.some((memory) => memory.source.conversationId !== grant.conversationId)
    )
      readFailure('unavailable', context);
  }
  const pending = query.grantId
    ? { status: 'available' as const, value: [] }
    : await createMemoryApiClient(context.fetch).listPending(session, selected);
  if (pending.status !== 'available') readFailure(pending.status, context);
  return {
    ...page,
    grants,
    grantId: query.grantId,
    memoryPage: result.value,
    pendingRevocations: pending.value,
  };
}
export async function loadMemoryPage(
  context: Context & Pick<RequestEvent, 'url'>,
  workspaceId: string,
  groupId: string,
  memoryId: string,
) {
  const query = pageQuery(context.url);
  if (query.after) readFailure('invalid', context);
  const page = await scope(context, workspaceId, groupId);
  const result = await createMemoryApiClient(context.fetch).get(
    readSessionCookie(context.cookies),
    { workspaceId, groupId, ...(query.grantId ? { grantId: query.grantId } : {}) },
    memoryId,
  );
  if (result.status !== 'available') readFailure(result.status, context);
  const bots = await createBotApiClient(context.fetch).list(
    readSessionCookie(context.cookies),
    workspaceId,
  );
  if (bots.status !== 'available') readFailure(bots.status, context);
  return {
    ...page,
    grantId: query.grantId,
    memory: result.value,
    destinationBots: bots.value.filter(
      (bot) =>
        bot.lifecycleState === 'active' &&
        (bot.accessRole === 'owner' || bot.accessRole === 'editor'),
    ),
  };
}
function actionFailure(
  status: string,
  context: Context,
  action:
    | 'saveMemory'
    | 'search'
    | 'previewPromotion'
    | 'confirmPromotion'
    | 'editMemory'
    | 'forgetMemory'
    | 'retainMemory'
    | 'revokeMemory',
  values: Record<string, string>,
) {
  if (status === 'anonymous') readFailure(status, context);
  const conflict = status === 'idempotency-conflict' || status === 'version-conflict';
  return fail(status === 'forbidden' ? 403 : status === 'invalid' ? 400 : conflict ? 409 : 503, {
    action,
    values,
    conflict,
    error:
      status === 'forbidden'
        ? 'Your current group access or source visibility no longer allows this memory.'
        : status === 'invalid'
          ? action === 'editMemory'
            ? 'Replacement text must be 1 to 1000 characters.'
            : 'Choose a current message and a confidence estimate between 0 and 1. Search text must be at most 200 characters.'
          : status === 'version-conflict'
            ? 'This memory or its source changed. Refresh before retrying.'
            : status === 'idempotency-conflict'
              ? 'This command key already has different choices. Refresh before saving another memory.'
              : 'The result could not be confirmed. Retry the unchanged form with the same command key.',
  });
}
async function formValues(request: Request, allowed: string[], maxLength = 800) {
  const values: Record<string, string> = {},
    form = await request.formData();
  for (const [key, value] of form) {
    if (
      !allowed.includes(key) ||
      typeof value !== 'string' ||
      form.getAll(key).length !== 1 ||
      value.length > maxLength
    )
      throw new Error('Invalid memory form');
    values[key] = value;
  }
  return values;
}
function validOrigin(request: Request) {
  return (
    request.headers.get('origin') ===
    new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin
  );
}
export async function saveMemoryAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  conversationId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (!validOrigin(context.request)) return actionFailure('forbidden', context, 'saveMemory', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, [
      'groupId',
      'messageId',
      'expectedSourceEventId',
      'idempotencyKey',
      'confidence',
    ]);
  } catch {
    return actionFailure('invalid', context, 'saveMemory', {});
  }
  if (
    !isConversationUuid(workspaceId) ||
    !isConversationUuid(conversationId) ||
    !isConversationUuid(values.groupId) ||
    !isConversationUuid(values.messageId) ||
    !isConversationUuid(values.expectedSourceEventId) ||
    !isCommandKey(values.idempotencyKey) ||
    !values.confidence?.trim() ||
    !Number.isFinite(Number(values.confidence)) ||
    Number(values.confidence) < 0 ||
    Number(values.confidence) > 1
  )
    return actionFailure('invalid', context, 'saveMemory', values);
  const session = readSessionCookie(context.cookies);
  const current = await createConversationApiClient(context.fetch).get(
    session,
    workspaceId,
    conversationId,
    { messageId: values.messageId, limit: 1 },
  );
  if (current.status !== 'available')
    return actionFailure(current.status, context, 'saveMemory', values);
  if (
    current.value.conversation.subject.kind !== 'group' ||
    current.value.conversation.subject.id !== values.groupId.toLowerCase()
  )
    return actionFailure('forbidden', context, 'saveMemory', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).create(
    session,
    { workspaceId, groupId: current.value.conversation.subject.id },
    {
      messageId: values.messageId,
      expectedSourceEventId: values.expectedSourceEventId,
      confidence: Number(values.confidence),
      idempotencyKey: values.idempotencyKey,
    },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'saveMemory', values);
  if (result.value.source.conversationId !== conversationId.toLowerCase())
    return actionFailure('unavailable', context, 'saveMemory', values);
  redirect(
    303,
    `/app/workspaces/${result.value.scope.workspaceId}/groups/${result.value.scope.groupId}/memories/${result.value.id}`,
  );
}
export async function searchMemoryAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  groupId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (!validOrigin(context.request)) return actionFailure('forbidden', context, 'search', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['query', 'grantId', 'after']);
  } catch {
    return actionFailure('invalid', context, 'search', {});
  }
  if (
    (values.grantId && !isConversationUuid(values.grantId)) ||
    (values.after && !isConversationUuid(values.after))
  )
    return actionFailure('invalid', context, 'search', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).search(
    readSessionCookie(context.cookies),
    { workspaceId, groupId, ...(values.grantId ? { grantId: values.grantId } : {}) },
    { query: values.query ?? '', ...(values.after ? { after: values.after } : {}) },
  );
  if (result.status !== 'available') return actionFailure(result.status, context, 'search', values);
  return {
    action: 'search' as const,
    values,
    conflict: false,
    error: '',
    memoryPage: result.value,
  };
}
export async function previewPromotionAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  groupId: string,
  memoryId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (!validOrigin(context.request))
    return actionFailure('forbidden', context, 'previewPromotion', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['destinationBotId']);
  } catch {
    return actionFailure('invalid', context, 'previewPromotion', {});
  }
  if (!isConversationUuid(values.destinationBotId))
    return actionFailure('invalid', context, 'previewPromotion', values);
  const result = await createMemoryApiClient(
    context.fetch,
    context.request.signal,
  ).previewPromotion(
    readSessionCookie(context.cookies),
    { workspaceId, groupId },
    memoryId,
    values.destinationBotId,
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'previewPromotion', values);
  return {
    action: 'previewPromotion' as const,
    values,
    conflict: false,
    error: '',
    preview: result.value,
  };
}
export async function confirmPromotionAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  groupId: string,
  memoryId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (!validOrigin(context.request))
    return actionFailure('forbidden', context, 'confirmPromotion', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['intentId', 'idempotencyKey']);
  } catch {
    return actionFailure('invalid', context, 'confirmPromotion', {});
  }
  if (!isConversationUuid(values.intentId) || !isCommandKey(values.idempotencyKey))
    return actionFailure('invalid', context, 'confirmPromotion', values);
  const result = await createMemoryApiClient(
    context.fetch,
    context.request.signal,
  ).confirmPromotion(readSessionCookie(context.cookies), { workspaceId, groupId }, memoryId, {
    intentId: values.intentId,
    idempotencyKey: values.idempotencyKey,
  });
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'confirmPromotion', values);
  redirect(
    303,
    `/app/workspaces/${result.value.scope.workspaceId}/bots/${result.value.scope.botId}/private-memories`,
  );
}
export async function editMemoryAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  groupId: string,
  memoryId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (!validOrigin(context.request)) return actionFailure('forbidden', context, 'editMemory', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['expectedVersionId', 'body'], 4096);
  } catch {
    return actionFailure('invalid', context, 'editMemory', {});
  }
  if (!isConversationUuid(values.expectedVersionId) || !values.body?.trim())
    return actionFailure('invalid', context, 'editMemory', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).edit(
    readSessionCookie(context.cookies),
    { workspaceId, groupId },
    memoryId,
    { expectedVersionId: values.expectedVersionId, body: values.body },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'editMemory', values);
  redirect(
    303,
    `/app/workspaces/${result.value.scope.workspaceId}/groups/${result.value.scope.groupId}/memories/${result.value.id}`,
  );
}
export async function forgetMemoryAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  groupId: string,
  memoryId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (!validOrigin(context.request)) return actionFailure('forbidden', context, 'forgetMemory', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['expectedVersionId']);
  } catch {
    return actionFailure('invalid', context, 'forgetMemory', {});
  }
  if (!isConversationUuid(values.expectedVersionId))
    return actionFailure('invalid', context, 'forgetMemory', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).forget(
    readSessionCookie(context.cookies),
    { workspaceId, groupId },
    memoryId,
    { expectedVersionId: values.expectedVersionId },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'forgetMemory', values);
  redirect(303, `/app/workspaces/${workspaceId}/groups/${groupId}/memories`);
}
export async function retainMemoryAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  groupId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (!validOrigin(context.request)) return actionFailure('forbidden', context, 'retainMemory', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['memoryId', 'expectedVersionId', 'idempotencyKey']);
  } catch {
    return actionFailure('invalid', context, 'retainMemory', {});
  }
  if (
    !isConversationUuid(values.memoryId) ||
    !isConversationUuid(values.expectedVersionId) ||
    !isCommandKey(values.idempotencyKey)
  )
    return actionFailure('invalid', context, 'retainMemory', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).retain(
    readSessionCookie(context.cookies),
    { workspaceId, groupId },
    values.memoryId,
    { expectedVersionId: values.expectedVersionId, idempotencyKey: values.idempotencyKey },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'retainMemory', values);
  redirect(
    303,
    `/app/workspaces/${result.value.scope.workspaceId}/groups/${result.value.scope.groupId}/memories/${result.value.id}`,
  );
}
export async function revokeMemoryAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  groupId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (!validOrigin(context.request)) return actionFailure('forbidden', context, 'revokeMemory', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['memoryId', 'expectedVersionId', 'idempotencyKey']);
  } catch {
    return actionFailure('invalid', context, 'revokeMemory', {});
  }
  if (
    !isConversationUuid(values.memoryId) ||
    !isConversationUuid(values.expectedVersionId) ||
    !isCommandKey(values.idempotencyKey)
  )
    return actionFailure('invalid', context, 'revokeMemory', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).revoke(
    readSessionCookie(context.cookies),
    { workspaceId, groupId },
    values.memoryId,
    { expectedVersionId: values.expectedVersionId, idempotencyKey: values.idempotencyKey },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'revokeMemory', values);
  redirect(303, `/app/workspaces/${workspaceId}/groups/${groupId}/memories`);
}

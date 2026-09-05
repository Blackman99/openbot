import { randomUUID } from 'node:crypto';
import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { requireConversationWorkspace } from './conversation-page.js';
import {
  createConversationApiClient,
  isConversationCursor,
  isCommandKey,
  isConversationUuid,
} from './conversation-api.js';
import { createGroupBotApiClient } from './group-bot-api.js';
import { createTaskApiClient } from './task-api.js';
import {
  clearSessionCookie,
  readSessionCookie,
  preventAuthenticationCaching,
} from './session-cookie.js';
type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders' | 'request' | 'url'>;
export async function loadTaskPage(
  context: Context,
  workspaceId: string,
  conversationId: string,
  taskId: string,
) {
  if (!isConversationUuid(taskId)) readFailure('invalid', context);
  const page = await scope(context, workspaceId, conversationId);
  const result = await createTaskApiClient(context.fetch, context.request.signal).get(
    readSessionCookie(context.cookies),
    page.workspace.id,
    page.conversation.id,
    taskId,
  );
  if (result.status !== 'available') readFailure(result.status, context);
  return { ...page, task: result.value };
}
function actionFailure(status: string, context: Context, values: Record<string, string>) {
  if (status === 'anonymous') readFailure(status, context);
  const known: Record<string, [number, string]> = {
    forbidden: [
      403,
      'Your current access does not allow this task. Refresh to check conversation and Bot membership.',
    ],
    invalid: [
      400,
      'Enter a nonblank prompt of up to 32,000 characters and choose a current group Bot when required.',
    ],
    'model-unavailable': [
      409,
      'The selected Bot model is currently unavailable to you. Your draft is preserved.',
    ],
    'idempotency-conflict': [
      409,
      'This submission was already used with different content. Your draft is preserved. Refresh tasks before starting a new request.',
    ],
  };
  const detail = known[status];
  return fail(detail?.[0] ?? 503, {
    values,
    conflict: status === 'idempotency-conflict',
    uncertain: !detail,
    error:
      detail?.[1] ??
      'The task could not be confirmed. Retry the unchanged prompt and Bot choice to check the original submission.',
  });
}
export async function submitTask(context: Context, workspaceId: string, conversationId: string) {
  preventAuthenticationCaching(context.setHeaders);
  if (
    context.request.headers.get('origin') !==
    new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin
  )
    return actionFailure('forbidden', context, {});
  const values: Record<string, string> = {};
  try {
    const form = await context.request.formData();
    for (const [key, value] of form) {
      if (
        !['idempotencyKey', 'body', 'groupGrantId'].includes(key) ||
        typeof value !== 'string' ||
        form.getAll(key).length !== 1 ||
        value.length > (key === 'body' ? 32000 : 128)
      )
        return actionFailure('invalid', context, values);
      values[key] = value;
    }
  } catch {
    return actionFailure('invalid', context, values);
  }
  if (
    !isCommandKey(values.idempotencyKey) ||
    !values.body?.trim() ||
    (values.groupGrantId !== undefined && !isConversationUuid(values.groupGrantId))
  )
    return actionFailure('invalid', context, values);
  const result = await createTaskApiClient(context.fetch, context.request.signal).submit(
    readSessionCookie(context.cookies),
    workspaceId,
    conversationId,
    {
      idempotencyKey: values.idempotencyKey,
      body: values.body,
      ...(values.groupGrantId === undefined ? {} : { groupGrantId: values.groupGrantId }),
    },
  );
  if (result.status !== 'available') return actionFailure(result.status, context, values);
  redirect(
    303,
    `/app/workspaces/${workspaceId.toLowerCase()}/conversations/${conversationId.toLowerCase()}/tasks/${result.value.id}`,
  );
}
function readFailure(status: string, context: Context): never {
  if (status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden') error(403, 'You cannot access tasks in this conversation');
  if (status === 'invalid') error(400, 'Invalid task or page request');
  error(503, 'Tasks unavailable');
}
function query(url: URL) {
  const cursor = url.searchParams.get('cursor'),
    limit = url.searchParams.get('limit');
  if (
    [...url.searchParams.keys()].some((key) => key !== 'cursor' && key !== 'limit') ||
    url.searchParams.getAll('cursor').length > 1 ||
    url.searchParams.getAll('limit').length > 1 ||
    (cursor !== null && !isConversationCursor(cursor)) ||
    (limit !== null && (!/^[1-9][0-9]?$/u.test(limit) || Number(limit) > 50))
  )
    error(400, 'Invalid task page request');
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(limit === null ? {} : { limit: Number(limit) }),
  };
}
async function scope(context: Context, workspaceId: string, conversationId: string) {
  const page = await requireConversationWorkspace(context, workspaceId);
  const result = await createConversationApiClient(context.fetch).get(
    readSessionCookie(context.cookies),
    page.workspace.id,
    conversationId,
    { limit: 1 },
  );
  if (result.status !== 'available') readFailure(result.status, context);
  return { ...page, conversation: result.value.conversation, canWrite: result.value.canWrite };
}
export async function loadTasksPage(context: Context, workspaceId: string, conversationId: string) {
  const pageQuery = query(context.url);
  const page = await scope(context, workspaceId, conversationId);
  const session = readSessionCookie(context.cookies);
  const result = await createTaskApiClient(context.fetch, context.request.signal).list(
    session,
    page.workspace.id,
    page.conversation.id,
    pageQuery,
  );
  if (result.status !== 'available') readFailure(result.status, context);
  const grants: Array<{ id: string; name: string }> = [];
  if (page.conversation.subject.kind === 'group' && page.canWrite) {
    const membership = await createGroupBotApiClient(context.fetch, context.request.signal).list(
      session,
      page.workspace.id,
      page.conversation.subject.id,
    );
    if (membership.status !== 'available') readFailure(membership.status, context);
    for (const grant of membership.value.grants) {
      if (grant.conversationId !== page.conversation.id) readFailure('unavailable', context);
      if (grant.closed === null && grant.bot.lifecycleState === 'active')
        grants.push({ id: grant.id, name: grant.bot.name });
    }
  }
  return {
    ...page,
    tasks: result.value.tasks,
    nextCursor: result.value.nextCursor,
    grants,
    canSubmit:
      page.canWrite && (page.conversation.subject.kind === 'direct-bot' || grants.length > 0),
    cursor: pageQuery.cursor ?? null,
    limit: pageQuery.limit ?? 20,
    idempotencyKey: String(randomUUID()),
  };
}
